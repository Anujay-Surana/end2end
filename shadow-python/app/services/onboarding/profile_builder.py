"""
Fast Onboarding Profile Builder

Builds lightweight user profile during onboarding with parallel web/email inference.
Target: 5-7 seconds per step (hard constraint).
"""

import asyncio
from typing import Dict, Any, Optional, List
from datetime import datetime
from app.services.gpt_service import call_gpt, safe_parse_json
from app.services.parallel_client import get_parallel_client
from app.services.logger import logger
from app.services.user_context import get_user_context


async def build_fast_profile(
    user: Dict[str, Any],
    user_emails: Optional[List[Dict[str, Any]]] = None,
    parallel_client: Optional[Any] = None,
    request_id: str = None
) -> Dict[str, Any]:
    """
    Build fast user profile during onboarding
    
    Args:
        user: User object with basic info (id, email, name)
        user_emails: Optional list of user's emails (sent emails preferred)
        parallel_client: Optional Parallel AI client for web search
        request_id: Request ID for logging
    
    Returns:
        Lightweight profile with: role, company, location, contact_points, responsibilities, specialization
    """
    start_time = datetime.now()
    
    # Get user context for email list
    user_context = await get_user_context(user, request_id)
    user_name = user_context.get('name') or user.get('name') or ''
    user_email = user_context.get('email') or user.get('email') or ''
    
    # Initialize profile with defaults
    profile = {
        'role': None,
        'company': None,
        'location': None,
        'contactPoints': [],
        'responsibilities': [],
        'specialization': None,
        'confidence': 'low',
        'sources': []
    }
    
    # Get parallel client if not provided
    if not parallel_client:
        parallel_client = get_parallel_client()
    
    # Prepare email samples for analysis (limit to 10 most recent)
    email_samples = []
    if user_emails:
        email_samples = user_emails[:10]
    elif user_email:
        # If no emails provided, we'll rely on web search only
        email_samples = []
    
    # Run web search and email analysis in parallel (target: 5-7 seconds total)
    web_result = None
    email_result = None
    
    async def run_web_search():
        """Run web search for user profile"""
        if not parallel_client or not user_name or not user_email:
            return None
        
        try:
            domain = user_email.split('@')[1] if '@' in user_email else None
            queries = [
                f'"{user_name}" site:linkedin.com {domain}' if domain else f'"{user_name}" site:linkedin.com',
                f'"{user_name}" "{user_email}"',
                f'"{user_name}" professional profile'
            ]
            
            search_result = await parallel_client.beta.search(
                objective=f'Find professional information for {user_name} ({user_email}): current role, company, location, and responsibilities',
                search_queries=queries,
                max_results=5,
                max_chars_per_result=2000
            )
            
            if search_result.get('results'):
                # Validate results (check if name appears)
                name_words = [w for w in user_name.split(' ') if len(w) > 2]
                validated_results = []
                for r in search_result['results']:
                    text_to_search = f'{r.get("title", "")} {r.get("excerpt", "")} {r.get("url", "")}'.lower()
                    if name_words and any(word.lower() in text_to_search for word in name_words):
                        validated_results.append(r)
                    elif user_email.lower() in text_to_search:
                        validated_results.append(r)
                
                return validated_results[:3] if validated_results else None
        except Exception as e:
            logger.warn(f'Web search failed during fast profile: {str(e)}', requestId=request_id)
        return None
    
    async def run_email_analysis():
        """Analyze emails for profile extraction"""
        if not email_samples or len(email_samples) < 3:
            return None
        
        try:
            # Extract email signatures and content (last 5 emails)
            email_data = []
            for e in email_samples[:5]:
                body = (e.get('body') or e.get('snippet') or '').strip()
                signature_lines = '\n'.join(body.split('\n')[-10:]) if body else ''
                
                email_data.append({
                    'from': e.get('from', ''),
                    'subject': e.get('subject', ''),
                    'bodyPreview': body[:1000],
                    'signature': signature_lines
                })
            
            # Fast GPT analysis (target: 2-3 seconds)
            analysis = await call_gpt([{
                'role': 'system',
                'content': """Extract professional information from email signatures and content. Return JSON:
{
  "role": "Job title" | null,
  "company": "Company name" | null,
  "location": {"city": "...", "state": "...", "country": "..."} | null,
  "responsibilities": ["responsibility 1", "responsibility 2"] | [],
  "specialization": "Domain/expertise area" | null,
  "confidence": "high" | "medium" | "low"
}

Focus on explicit information in signatures. If uncertain, return null or low confidence."""
            }, {
                'role': 'user',
                'content': f'Email samples:\n{str(email_data)[:2000]}'
            }], 800)  # Lower token limit for speed
            
            parsed = safe_parse_json(analysis)
            if isinstance(parsed, dict):
                return parsed
        except Exception as e:
            logger.warn(f'Email analysis failed during fast profile: {str(e)}', requestId=request_id)
        return None
    
    # Run both in parallel with timeout (max 7 seconds)
    try:
        web_task = asyncio.create_task(run_web_search())
        email_task = asyncio.create_task(run_email_analysis())
        
        # Wait for both with 7 second timeout
        done, pending = await asyncio.wait(
            [web_task, email_task],
            timeout=7.0,
            return_when=asyncio.FIRST_COMPLETED
        )
        
        # Cancel pending tasks if timeout
        for task in pending:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        
        # Get results
        if web_task.done():
            try:
                web_result = await web_task
            except Exception:
                web_result = None
        
        if email_task.done():
            try:
                email_result = await email_task
            except Exception:
                email_result = None
        
    except asyncio.TimeoutError:
        logger.warn('Fast profile building timed out (>7s)', requestId=request_id)
        # Continue with whatever we have
    
    # Synthesize web search results if available
    web_profile = None
    if web_result:
        try:
            web_synthesis = await call_gpt([{
                'role': 'system',
                'content': f'Extract professional information about {user_name} ({user_email}) from web search results. Return JSON:
{{
  "role": "Current job title" | null,
  "company": "Current company" | null,
  "location": {{"city": "...", "state": "...", "country": "..."}} | null,
  "responsibilities": ["responsibility 1"] | [],
  "specialization": "Domain/expertise" | null,
  "confidence": "high" | "medium" | "low"
}}'
            }, {
                'role': 'user',
                'content': f'Web search results:\n{str(web_result)[:2000]}'
            }], 600)  # Lower token limit for speed
            
            web_parsed = safe_parse_json(web_synthesis)
            if isinstance(web_parsed, dict):
                web_profile = web_parsed
                profile['sources'].append('web_search')
        except Exception as e:
            logger.warn(f'Web synthesis failed: {str(e)}', requestId=request_id)
    
    # Merge results (prioritize web search, then email)
    if web_profile:
        profile['role'] = web_profile.get('role')
        profile['company'] = web_profile.get('company')
        profile['location'] = web_profile.get('location')
        profile['responsibilities'] = web_profile.get('responsibilities', [])
        profile['specialization'] = web_profile.get('specialization')
        profile['confidence'] = web_profile.get('confidence', 'medium')
    
    if email_result:
        if not profile['role']:
            profile['role'] = email_result.get('role')
        if not profile['company']:
            profile['company'] = email_result.get('company')
        if not profile['location']:
            profile['location'] = email_result.get('location')
        if not profile['responsibilities']:
            profile['responsibilities'] = email_result.get('responsibilities', [])
        if not profile['specialization']:
            profile['specialization'] = email_result.get('specialization')
        
        # Update confidence (email is less reliable than web)
        if email_result.get('confidence') == 'high' and profile['confidence'] == 'low':
            profile['confidence'] = 'medium'
        
        profile['sources'].append('email_analysis')
    
    # Extract contact points from email
    if user_email:
        profile['contactPoints'] = [user_email]
    
    # Infer company from email domain if not found
    if not profile['company'] and '@' in user_email:
        domain = user_email.split('@')[1]
        # Skip common email providers
        if domain not in ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com']:
            profile['company'] = domain.split('.')[0].title()
            profile['sources'].append('email_domain')
    
    # Calculate elapsed time
    elapsed = (datetime.now() - start_time).total_seconds()
    profile['_metadata'] = {
        'buildTimeSeconds': round(elapsed, 2),
        'hasWebData': web_result is not None,
        'hasEmailData': email_result is not None
    }
    
    logger.info(
        f'Fast profile built in {elapsed:.2f}s',
        requestId=request_id,
        role=profile['role'],
        company=profile['company'],
        confidence=profile['confidence'],
        sources=profile['sources']
    )
    
    return profile

