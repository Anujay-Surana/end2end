"""
GPT Service

Centralized OpenAI GPT-4.1-mini API client with retry logic and helper functions
"""

import os
import json
import asyncio
import httpx
from typing import List, Dict, Any, Optional
from datetime import datetime, date
from app.services.logger import logger

# Timeout in milliseconds
TIMEOUT_MS = 60000
MAX_RETRIES = 3


async def sleep(ms: int):
    """Sleep helper for rate limiting"""
    await asyncio.sleep(ms / 1000)


async def call_gpt(
    messages: List[Dict[str, str]],
    max_tokens: int = 2000,
    retry_count: int = 0
) -> str:
    """
    Call OpenAI GPT-4.1-mini for analysis with automatic retry on rate limits
    Args:
        messages: Array of message objects with role and content
        max_tokens: Maximum tokens to generate (default: 2000)
        retry_count: Current retry attempt (internal use)
    Returns:
        GPT response content
    """
    # Log request details
    request_id = f"req_{int(asyncio.get_event_loop().time() * 1000)}_{os.urandom(4).hex()}"
    message_count = len(messages) if isinstance(messages, list) else 0
    first_message_preview = messages[0].get('content', '')[:100] if messages and messages[0] else 'N/A'
    
    logger.info(
        f"\n📤 [{request_id}] GPT-4.1-mini API Request:",
        model="gpt-4.1-mini",
        max_completion_tokens=max_tokens,
        messages=message_count,
        first_message_preview=first_message_preview,
        retry_attempt=retry_count + 1,
        max_retries=MAX_RETRIES + 1
    )

    try:
        api_key = os.getenv('OPENAI_API_KEY')
        if not api_key:
            logger.error(f"   ❌ [{request_id}] OPENAI_API_KEY environment variable is not set!")
            raise Exception('OPENAI_API_KEY environment variable is not set')
        
        # Log API key info (masked for security)
        api_key_preview = api_key[:10] + '...' + api_key[-4:] if len(api_key) > 14 else '***'
        logger.debug(f"   API Key: {api_key_preview} (length: {len(api_key)})")
        
        request_body = {
            'model': 'gpt-4.1-mini',
            'messages': messages,
            'max_tokens': max_tokens
        }
        
        logger.debug(f"   Request body: {json.dumps(request_body, indent=2)[:500]}...")

        async with httpx.AsyncClient(timeout=TIMEOUT_MS / 1000) as client:
            response = await client.post(
                'https://api.openai.com/v1/chat/completions',
                headers={
                    'Content-Type': 'application/json',
                    'Authorization': f'Bearer {api_key}'
                },
                json=request_body
            )
        
        logger.info(
            f"\n📥 [{request_id}] GPT-4.1-mini API Response:",
            status=f"{response.status_code} {response.reason_phrase}",
            headers=dict(response.headers)
        )

        if not response.is_success:
            error_body = response.text
            error_details = ''
            error_json = None

            logger.error(f"   ❌ [{request_id}] API Error Response Body: {error_body[:1000]}")

            try:
                error_json = json.loads(error_body)
                error_details = json.dumps(error_json, indent=2)
                logger.error(f"   ❌ [{request_id}] Parsed Error: {error_details}")
            except:
                error_details = error_body
                logger.error(f"   ❌ [{request_id}] Raw Error Body: {error_body[:500]}")

            # Handle rate limit errors with automatic retry
            if response.status_code == 429 and retry_count < MAX_RETRIES:
                retry_after = response.headers.get('retry-after')
                wait_time = float(retry_after) * 1000 if retry_after else 5000

                # If we have the error message, try to parse wait time from it
                if error_json and error_json.get('error', {}).get('message'):
                    import re
                    match = re.search(r'Please try again in ([\d.]+)s', error_json['error']['message'])
                    if match:
                        wait_time = float(match.group(1)) * 1000

                logger.info(f"⏳ Rate limit hit. Waiting {wait_time/1000:.1f}s before retry {retry_count + 1}/{MAX_RETRIES}...")
                await sleep(wait_time)

                # Retry the request
                return await call_gpt(messages, max_tokens, retry_count + 1)

            # For non-429 errors or exhausted retries, log and throw
            rate_limit_reset = response.headers.get('x-ratelimit-reset-tokens')
            logger.error(f"❌ OpenAI API Error {response.status_code}:")
            logger.error(f"   Error Details: {error_details}")
            if response.status_code == 429 and retry_count >= MAX_RETRIES:
                logger.error(f"   ⚠️  Max retries ({MAX_RETRIES}) exceeded")

            raise Exception(f'GPT API error: {response.status_code} - {error_details}')

        response_text = response.text
        logger.debug(f"   Response body length: {len(response_text)} chars")
        logger.debug(f"   Response body preview: {response_text[:500]}...")
        
        try:
            data = json.loads(response_text)
        except json.JSONDecodeError as parse_error:
            logger.error(f"   ❌ [{request_id}] Failed to parse response as JSON: {parse_error}")
            logger.error(f"   Raw response: {response_text[:1000]}")
            raise Exception(f'GPT API returned invalid JSON: {parse_error}')
        
        response_structure = {
            'hasChoices': bool(data.get('choices')),
            'choicesLength': len(data.get('choices', [])),
            'hasUsage': bool(data.get('usage')),
            'model': data.get('model', 'not provided'),
            'id': data.get('id', 'not provided')
        }
        logger.debug(f"   Response structure: {response_structure}")
        
        # Log full response structure for debugging
        logger.debug(f"   Full response: {json.dumps(data, indent=2)[:2000]}")
        
        # Log response for debugging if empty or invalid
        if not data.get('choices') or not data['choices']:
            logger.error(f"   ❌ [{request_id}] GPT API returned invalid response structure: {json.dumps(data, indent=2)[:1000]}")
            raise Exception('GPT API returned invalid response: missing choices[0]')
        
        if not data['choices'][0].get('message'):
            logger.error(f"   ❌ [{request_id}] GPT API returned invalid response structure: {json.dumps(data, indent=2)[:1000]}")
            raise Exception('GPT API returned invalid response: missing choices[0].message')
        
        message = data['choices'][0]['message']
        finish_reason = data['choices'][0].get('finish_reason')
        
        # Check for refusal field
        refusal = message.get('refusal')
        
        message_structure = {
            'role': message.get('role'),
            'hasContent': bool(message.get('content')),
            'contentLength': len(message.get('content', '')),
            'hasToolCalls': bool(message.get('tool_calls')),
            'finishReason': finish_reason,
            'hasRefusal': bool(refusal),
            'refusal': refusal
        }
        logger.debug(f"   Message structure: {message_structure}")
        
        # Analyze finish_reason for potential issues
        if finish_reason != 'stop':
            logger.warning(f"   ⚠️  [{request_id}] Unusual finish reason: {finish_reason}")
            if finish_reason == 'content_filter':
                logger.warning("   ⚠️  Content was filtered by OpenAI's safety system - response may be incomplete")
            elif finish_reason == 'length':
                logger.warning(f"   ⚠️  Response was truncated due to max_tokens limit ({max_tokens} tokens)")
            elif finish_reason == 'tool_calls':
                logger.info("   ℹ️  Response contains tool calls (function calling)")
        
        # Handle refusal case
        if refusal:
            logger.error(f"   ❌ [{request_id}] GPT-4.1-mini refused to generate content. Refusal: {json.dumps(refusal, indent=2)}")
            logger.error(f"   Model used: gpt-4.1-mini")
            logger.error(f"   Usage: {json.dumps(data.get('usage')) if data.get('usage') else 'not provided'}")
            logger.error(f"   Finish reason: {finish_reason}")
            raise Exception(f'GPT-4.1-mini refused to generate content: {json.dumps(refusal)}')
        
        # Handle empty content (even if refusal is null)
        message_content = message.get('content', '')
        if not message_content or (isinstance(message_content, str) and message_content.strip() == ''):
            # Special handling for "length" finish_reason with empty content
            # GPT-4.1-mini may return empty content when hitting token limit if response would be too long
            usage = data.get('usage', {})
            completion_tokens = usage.get('completion_tokens', 0)
            if finish_reason == 'length' and completion_tokens >= max_tokens * 0.95:
                logger.error(f"   ❌ [{request_id}] GPT-4.1-mini hit token limit ({completion_tokens}/{max_tokens}) and returned empty content")
                logger.error("   This suggests the response would exceed the limit. Consider increasing max_tokens.")
                logger.error(f"   Model used: gpt-4.1-mini")
                logger.error(f"   Usage: {json.dumps(usage)}")
                logger.error(f"   Finish reason: {finish_reason}")
                
                # Retry with higher token limit if we haven't exceeded retries
                if retry_count < MAX_RETRIES and max_tokens < 8000:
                    new_max_tokens = min(max_tokens * 2, 8000)
                    logger.info(f"   🔄 [{request_id}] Retrying with increased token limit: {max_tokens} → {new_max_tokens}")
                    return await call_gpt(messages, new_max_tokens, retry_count + 1)
                
                raise Exception(f'GPT-4.1-mini returned empty content due to token limit ({completion_tokens}/{max_tokens}). Try increasing max_tokens.')
            
            logger.error(f"   ❌ [{request_id}] GPT-4.1-mini returned empty content. Full response: {json.dumps(data, indent=2)[:2000]}")
            logger.error(f"   Model used: gpt-4.1-mini")
            logger.error(f"   Usage: {json.dumps(usage) if usage else 'not provided'}")
            logger.error(f"   Finish reason: {finish_reason}")
            logger.error(f"   Refusal: {refusal or 'null'}")
            logger.error(f"   Annotations: {message.get('annotations') or 'none'}")
            
            # Check if there are annotations that might explain the empty content
            annotations = message.get('annotations')
            if annotations and isinstance(annotations, list) and len(annotations) > 0:
                logger.error(f"   Annotations details: {json.dumps(annotations, indent=2)}")
            
            raise Exception(f'GPT-4.1-mini returned empty content - check finish_reason ({finish_reason}), refusal, and annotations for details')
        
        content = message_content.strip()
        logger.info(f"   ✅ [{request_id}] Success! Content length: {len(content)} chars")
        logger.debug(f"   Content preview: {content[:200]}...")
        
        # Validate content length relative to token usage
        usage = data.get('usage', {})
        completion_tokens = usage.get('completion_tokens')
        if len(content) > 0 and completion_tokens:
            avg_chars_per_token = len(content) / completion_tokens
            logger.debug(f"   Content efficiency: {avg_chars_per_token:.2f} chars/token")
            if avg_chars_per_token < 2:
                logger.warning(f"   ⚠️  [{request_id}] Very low chars/token ratio: {avg_chars_per_token:.2f} (might indicate encoding issues or unusual content)")
            if completion_tokens >= max_tokens * 0.95:
                logger.warning(f"   ⚠️  [{request_id}] Used {completion_tokens}/{max_tokens} tokens (95%+) - response may be truncated")
        
        if len(content) == 0:
            logger.warning(f"   ⚠️  [{request_id}] GPT API returned empty trimmed content. Raw content length: {len(message_content)}")
            logger.warning(f"   Raw content: {message_content}")
            logger.warning(f"   Finish reason: {finish_reason}")
        
        if usage:
            logger.debug(f"   Token usage: {json.dumps(usage)}")
        
        return content

    except httpx.TimeoutException:
        logger.error(f"\n❌ [{request_id}] GPT-4.1-mini API Call Error:")
        logger.error(f"   Error name: TimeoutException")
        logger.error(f"   ⚠️  Request timed out after {TIMEOUT_MS}ms")
        raise Exception('GPT API request timed out after 60 seconds')
    except Exception as error:
        logger.error(f"\n❌ [{request_id}] GPT-4.1-mini API Call Error:")
        logger.error(f"   Error name: {type(error).__name__}")
        logger.error(f"   Error message: {str(error)}")
        logger.error(f"   Error stack: {error.__traceback__}")
        
        # If it's a network error and we haven't exceeded retries, retry with exponential backoff
        error_msg = str(error)
        if retry_count < MAX_RETRIES and ('fetch' in error_msg.lower() or 'timeout' in error_msg.lower() or 'network' in error_msg.lower()):
            wait_time = min(1000 * (2 ** retry_count), 10000)  # Cap at 10s
            logger.info(f"   ⏳ [{request_id}] Network error. Waiting {wait_time/1000:.1f}s before retry {retry_count + 1}/{MAX_RETRIES}...")
            await sleep(wait_time)
            return await call_gpt(messages, max_tokens, retry_count + 1)
        
        logger.error(f"   ❌ [{request_id}] Not retrying - max retries exceeded or non-retryable error")
        raise


def _json_serialize_datetime(obj: Any) -> Any:
    """
    Custom JSON serializer for datetime objects and other non-serializable types
    """
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    elif isinstance(obj, set):
        return list(obj)
    elif hasattr(obj, '__dict__'):
        return obj.__dict__
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


async def synthesize_results(prompt: str, data: Dict[str, Any], max_tokens: int = 2000) -> Optional[str]:
    """
    Synthesize results with strict fact-checking
    Args:
        prompt: The synthesis prompt
        data: Data to synthesize (may contain datetime objects)
        max_tokens: Maximum tokens (default: 2000)
    Returns:
        Synthesized result or None on error
    """
    try:
        # Convert data to JSON-safe format (handle datetime objects)
        try:
            data_json = json.dumps(data, default=_json_serialize_datetime, ensure_ascii=False)[:12000]
        except (TypeError, ValueError) as json_error:
            logger.error(f'❌ Error serializing data for synthesis: {str(json_error)}')
            # Fallback: try to clean data recursively
            def clean_for_json(obj):
                if isinstance(obj, (datetime, date)):
                    return obj.isoformat()
                elif isinstance(obj, dict):
                    return {k: clean_for_json(v) for k, v in obj.items()}
                elif isinstance(obj, (list, tuple)):
                    return [clean_for_json(item) for item in obj]
                elif isinstance(obj, set):
                    return list(obj)
                else:
                    return obj
            cleaned_data = clean_for_json(data)
            data_json = json.dumps(cleaned_data, ensure_ascii=False)[:12000]
        
        result = await call_gpt([{
            'role': 'system',
            'content': """You are an executive briefing expert. Your task is to extract and synthesize information from data based on the specific prompt provided.

CORE PRINCIPLES:
1. **Verify before including**: ONLY include information directly supported by the provided data
2. **Be specific**: Include numbers, dates, names, companies, titles, concrete details
3. **Context-appropriate length**:
   - For fact extraction: 15-80 words per fact
   - For narrative synthesis: Follow prompt guidance (typically 6-12 sentences)
4. **Quality over quantity**: Return fewer high-quality insights rather than padding with generic statements
5. **Skip obvious/generic**: No "experienced professional", "works in tech", "team member" unless there's specific detail
6. **Business relevance**: Focus on information useful for meeting preparation and decision-making

OUTPUT FORMAT:
- Follow the prompt's explicit output format instructions (JSON array, paragraph, etc.)
- If prompt asks for JSON, return valid JSON only (no markdown code blocks unless you strip them)
- If prompt asks for narrative, write cohesive prose
- If data is insufficient for quality output, acknowledge it explicitly

VALIDATION CHECKS:
- Does each statement have evidence in the data?
- Would this information actually help in a meeting context?
- Is this specific enough to be actionable?
- Have I followed the prompt's specific instructions?"""
        }, {
            'role': 'user',
            'content': f"{prompt}\n\nData:\n{data_json}"
        }], max_tokens)

        if not result or result.strip() == '':
            logger.warning('⚠️  synthesizeResults returned empty result')
            return None
        return result
    except Exception as error:
        logger.error(f'❌ Error synthesizing: {str(error)}')
        logger.error(f'Error stack: {error.__traceback__}')
        return None


def safe_parse_json(text: str) -> Optional[Any]:
    """
    Safely parse JSON that may be wrapped in markdown code blocks
    Only strips backticks at the START and END, not throughout the content
    Args:
        text: JSON string that may have markdown code blocks
    Returns:
        Parsed JSON object or None on error
    """
    if not text:
        logger.warning('⚠️  safeParseJSON received null/undefined text')
        return None

    cleaned = text.strip()
    
    # Log what we're trying to parse (first 200 chars for debugging)
    if len(cleaned) < 200:
        logger.debug(f"🔍 Parsing JSON (full): {cleaned}")
    else:
        logger.debug(f"🔍 Parsing JSON (first 200 chars): {cleaned[:200]}...")

    # Remove markdown code blocks ONLY at start/end (not in the middle of content)
    # This prevents corrupting JSON that contains backticks in its content
    if cleaned.startswith('```'):
        # Remove opening code block (```json or just ```)
        import re
        cleaned = re.sub(r'^```(?:json)?\s*\n?', '', cleaned)

    if cleaned.endswith('```'):
        # Remove closing code block
        cleaned = re.sub(r'\n?```\s*$', '', cleaned)

    # Try direct parse first
    try:
        parsed = json.loads(cleaned.strip())
        logger.info(f"✅ JSON parsed successfully: {'Array with ' + str(len(parsed)) + ' items' if isinstance(parsed, list) else type(parsed).__name__}")
        return parsed
    except json.JSONDecodeError as error:
        logger.error(f"❌ Error parsing JSON: {str(error)}")
        logger.error(f"   Text being parsed: {cleaned[:500]}")
        
        # Try to fix common JSON issues
        # 1. Remove trailing commas before closing braces/brackets
        import re
        cleaned_fixed = re.sub(r',(\s*[}\]])', r'\1', cleaned)
        
        # Try parsing again with fixed JSON
        try:
            parsed = json.loads(cleaned_fixed.strip())
            logger.info(f"✅ JSON parsed successfully after fixing trailing commas: {'Array with ' + str(len(parsed)) + ' items' if isinstance(parsed, list) else type(parsed).__name__}")
            return parsed
        except json.JSONDecodeError:
            pass
        
        # 2. Try to extract JSON array from narrative text
        # Look for array-like patterns: [...]
        array_match = re.search(r'\[[\s\S]*?\]', cleaned)
        if array_match:
            try:
                extracted = json.loads(array_match.group(0))
                logger.info(f"✅ Extracted JSON array from text: {'Array with ' + str(len(extracted)) + ' items' if isinstance(extracted, list) else type(extracted).__name__}")
                return extracted
            except json.JSONDecodeError as e:
                logger.error(f"   Failed to parse extracted array: {str(e)}")
        
        # 3. Try to find JSON object if array not found
        # Use non-greedy match first, then greedy if that fails
        object_match = re.search(r'\{[\s\S]*?\}', cleaned)
        if not object_match:
            object_match = re.search(r'\{[\s\S]*\}', cleaned)
        
        if object_match:
            try:
                extracted = json.loads(object_match.group(0))
                logger.info(f"✅ Extracted JSON object from text: {type(extracted).__name__}")
                # If it's an object with an array property, return that
                if isinstance(extracted, dict):
                    if 'facts' in extracted and isinstance(extracted['facts'], list):
                        return extracted['facts']
                    if 'items' in extracted and isinstance(extracted['items'], list):
                        return extracted['items']
                    # Try to find any array property
                    for key, value in extracted.items():
                        if isinstance(value, list):
                            return value
                return extracted
            except json.JSONDecodeError as e:
                logger.error(f"   Failed to parse extracted object: {str(e)}")
                logger.error(f"   Extracted text: {object_match.group(0)[:500]}")
        
        # 4. If all else fails, try to extract partial JSON (up to error position)
        if hasattr(error, 'pos') and error.pos:
            try:
                partial_json = cleaned[:error.pos]
                # Try to find the last complete JSON structure
                last_brace = partial_json.rfind('}')
                last_bracket = partial_json.rfind(']')
                if last_brace > last_bracket:
                    partial_json = partial_json[:last_brace + 1]
                elif last_bracket > last_brace:
                    partial_json = partial_json[:last_bracket + 1]
                
                if partial_json:
                    extracted = json.loads(partial_json)
                    logger.warn(f"⚠️  Extracted partial JSON (truncated at error position): {type(extracted).__name__}")
                    return extracted
            except:
                pass
        
        return None


async def craft_search_queries(context: str) -> List[str]:
    """
    Craft search queries from context
    Args:
        context: Context to generate queries from
    Returns:
        Array of search queries (max 3)
    """
    try:
        result = await call_gpt([{
            'role': 'system',
            'content': 'Generate EXACTLY 3 highly specific web search queries. Return ONLY a JSON array. Example: ["query 1", "query 2", "query 3"]'
        }, {
            'role': 'user',
            'content': context
        }], 200)

        parsed = safe_parse_json(result)
        return parsed[:3] if isinstance(parsed, list) else []
    except Exception as error:
        logger.error(f'Error crafting queries: {error}')
        return []

