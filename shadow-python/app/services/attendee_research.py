"""
Attendee Research Service

Researches meeting attendees using email context and web search (Parallel AI)
Extracts professional information, company details, and key facts about each attendee
"""

import re
import asyncio
from typing import List, Dict, Any, Optional
from app.services.gpt_service import synthesize_results, safe_parse_json
from app.services.logger import logger


def _is_educational_domain(domain: str) -> bool:
    """Check if domain is educational"""
    if not domain:
        return False
    return (
        domain.endswith('.edu') or
        domain.endswith('.ac.uk') or
        domain.endswith('.edu.au') or
        domain.endswith('.ac.za') or
        '.edu.' in domain
    )


def _is_generic_domain(domain: str) -> bool:
    """Check if domain is generic email provider"""
    if not domain:
        return False
    return domain in [
        'gmail.com', 'yahoo.com', 'outlook.com',
        'hotmail.com', 'icloud.com', 'protonmail.com'
    ]


def _extract_name_from_header(header: str, attendee_email: str) -> Optional[str]:
    """Extract name from email header (From or To)"""
    if not header:
        return None
    
    # Handle multiple recipients: "Name1 <email1>, Name2 <email2>"
    recipients = [r.strip() for r in header.split(',')]
    for recipient in recipients:
        if attendee_email.lower() in recipient.lower():
            # Match: Name <email> or "Name" <email>
            match = re.match(r'^([^<]+)(?=\s*<)', recipient)
            if match:
                extracted_name = match.group(1).strip().replace('"', '')
                if ' ' in extracted_name or len(extracted_name) > len(attendee_email.split('@')[0]):
                    return extracted_name
    return None


async def _research_single_attendee(
    attendee: Dict[str, Any],
    emails: List[Dict[str, Any]],
    calendar_events: List[Dict[str, Any]],
    meeting_title: str,
    meeting_date_context: str,
    user_context: Optional[Dict[str, Any]],
    parallel_client: Optional[Any],
    request_id: str
) -> Optional[Dict[str, Any]]:
    """
    Research a single attendee
    Returns attendee result with name, email, company, title, keyFacts, etc.
    """
    # Handle Google Calendar format: att.email or att.emailAddress
    attendee_email = attendee.get('email') or attendee.get('emailAddress')
    if not attendee_email:
        logger.info(f'  ⏭️  Skipping attendee without email: {attendee}', requestId=request_id)
        return None

    domain = attendee_email.split('@')[1] if '@' in attendee_email else None

    # Check if domain is educational or generic
    is_educational_domain = _is_educational_domain(domain) if domain else False
    is_generic_domain = _is_generic_domain(domain) if domain else False

    # Only infer company from corporate domains
    company = None
    if domain and not is_educational_domain and not is_generic_domain:
        company = domain.split('.')[0]

    # Skip resource calendars
    if '@resource.calendar.google.com' in attendee_email:
        logger.info(f'  ⏭️  Skipping resource calendar: {attendee.get("displayName") or attendee_email}', requestId=request_id)
        return None

    # Prioritize displayName from Calendar API, then name, then email prefix
    name = attendee.get('displayName') or attendee.get('name') or attendee_email.split('@')[0]
    if attendee.get('displayName'):
        logger.info(f'  📛 Using Calendar display name: "{attendee["displayName"]}"', requestId=request_id)
    elif attendee.get('name'):
        logger.info(f'  📛 Using Calendar name: "{attendee["name"]}"', requestId=request_id)
    else:
        logger.info(f'  ⚠️  No display name found, using email prefix: "{name}"', requestId=request_id)

    # Check past calendar events for display name if not found
    if not attendee.get('displayName') and not attendee.get('name') and calendar_events:
        for event in calendar_events:
            event_attendees = event.get('attendees', [])
            for a in event_attendees:
                event_email = (a.get('email') or a.get('emailAddress') or '').lower()
                if event_email == attendee_email.lower():
                    event_name = a.get('displayName') or a.get('name')
                    if event_name:
                        name = event_name
                        logger.info(f'    📛 Found display name from past calendar event: "{name}"', requestId=request_id)
                        break
            if name != (attendee.get('displayName') or attendee.get('name') or attendee_email.split('@')[0]):
                break

    logger.info(f'  🔍 Researching: {name} ({attendee_email})', requestId=request_id)

    key_facts = []
    title = company or ('Student' if is_educational_domain else None) or 'Unknown'
    source = 'local'

    # Extract full name from email headers if needed
    attendee_emails = []
    if emails:
        attendee_emails = [
            e for e in emails
            if attendee_email.lower() in (e.get('from', '') or '').lower()
        ]

    # Extract name from "From" header
    if attendee_emails and (' ' not in name or name == attendee_email.split('@')[0]):
        from_header = attendee_emails[0].get('from', '')
        extracted_name = _extract_name_from_header(from_header, attendee_email)
        if extracted_name:
            logger.info(f'    📛 Extracted full name from "From" header: "{extracted_name}"', requestId=request_id)
            name = extracted_name

    # Extract context from emails THEY sent AND emails TO them
    emails_to_attendee = []
    if emails:
        emails_to_attendee = [
            e for e in emails
            if attendee_email.lower() in (e.get('to', '') or '').lower()
        ]

    # Extract name from "To" header if we still don't have a full name
    if emails_to_attendee and (' ' not in name or name == attendee_email.split('@')[0]):
        for email in emails_to_attendee:
            to_header = email.get('to', '')
            if not to_header:
                continue
            extracted_name = _extract_name_from_header(to_header, attendee_email)
            if extracted_name:
                logger.info(f'    📛 Extracted name from "To" header: "{extracted_name}"', requestId=request_id)
                name = extracted_name
                break

    # Combine emails FROM and TO attendee, deduplicate by ID
    all_attendee_emails = attendee_emails + emails_to_attendee
    unique_attendee_emails = []
    seen_ids = set()
    for e in all_attendee_emails:
        email_id = e.get('id')
        if email_id and email_id not in seen_ids:
            seen_ids.add(email_id)
            unique_attendee_emails.append(e)

    email_data_for_synthesis = []

    if unique_attendee_emails:
        logger.info(
            f'    📧 Found {len(attendee_emails)} emails from {name}, '
            f'{len(emails_to_attendee)} emails to {name} ({len(unique_attendee_emails)} total unique)',
            requestId=request_id
        )

        # Prepare email data for synthesis
        email_data_for_synthesis = [
            {
                'subject': e.get('subject', ''),
                'from': e.get('from', ''),
                'to': e.get('to', ''),
                'date': e.get('date', ''),
                'body': e.get('body') or e.get('snippet', ''),
                'snippet': e.get('snippet', '')
            }
            for e in unique_attendee_emails[:20]
        ]

        # Fallback: Extract basic info from emails even if synthesis fails
        fallback_facts = []
        if email_data_for_synthesis:
            email_domain = attendee_email.split('@')[1] if '@' in attendee_email else None
            is_edu_domain = _is_educational_domain(email_domain) if email_domain else False
            is_gen_domain = _is_generic_domain(email_domain) if email_domain else False

            if email_domain and not is_edu_domain and not is_gen_domain:
                company_name = email_domain.split('.')[0]
                fallback_facts.append(f'Works at {company_name.capitalize()}')

            # Extract any project names or key terms from email subjects
            subjects = ' '.join([e.get('subject', '') for e in email_data_for_synthesis]).lower()
            project_keywords = ['project', 'meeting', 'report', 'proposal', 'plan', 'launch']
            found_keywords = [kw for kw in project_keywords if kw in subjects]
            if found_keywords:
                fallback_facts.append(f'Involved in {found_keywords[0]} communications')

            # Add communication frequency
            if len(unique_attendee_emails) >= 10:
                fallback_facts.append(f'Frequent collaborator ({len(unique_attendee_emails)} email exchanges)')

        logger.info(
            f'Synthesizing attendee email context',
            requestId=request_id,
            attendeeEmail=attendee_email,
            emailCount=len(email_data_for_synthesis),
            fallbackFactsCount=len(fallback_facts)
        )

        user_context_str = ''
        if user_context:
            user_context_str = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). '

        important_note = ''
        if user_context:
            important_note = f"IMPORTANT: Extract information that {user_context['formattedName']} should know about {name}. Structure facts from {user_context['formattedName']}'s perspective.\n\n"

        local_synthesis = await synthesize_results(
            f'{user_context_str}Analyze emails FROM {name} ({attendee_email}) to extract professional context for meeting "{meeting_title}".{meeting_date_context}\n\n'
            f'{important_note}'
            f'CRITICAL SCOPE: These emails include both emails SENT BY {name} (FROM: {attendee_email}) AND emails SENT TO {name} (TO: {attendee_email}). This provides a complete view of their communication patterns.\n\n'
            f'Extract and prioritize:\n'
            f'1. **Working relationship**: {"How does " + name + " collaborate with " + user_context["formattedName"] + " and others?" if user_context else "How do they collaborate with others?"}\n'
            f'2. **Current projects/progress**: What are they working on?\n'
            f'3. **Role and expertise**: Their position, responsibilities\n'
            f'4. **Meeting-specific context**: References to this meeting\'s topic\n'
            f'5. **Communication style**: How they communicate\n\n'
            f'OUTPUT FORMAT: Return ONLY a valid JSON array. CRITICAL: Must be valid JSON, no markdown code blocks, no explanations.\n\n'
            f'REQUIREMENTS:\n'
            f'- Return at least 1-2 facts even from limited context\n'
            f'- Each fact should be 15-80 words with concrete details\n'
            f'- Focus on: role, company, recent communications, any project mentions, collaboration patterns\n'
            f'- Extract ANY relevant information that {"the user" if not user_context else user_context["formattedName"]} should know about {name}\n\n'
            f'GOOD EXAMPLES:\n'
            f'["Sent \'Kordn8 MVP Functions Report\' on Nov 9 detailing current limitations", "Requested approval on UX wireframes in Dec 15 email", "Regularly coordinates with team on product roadmap"]\n\n'
            f'BAD EXAMPLES (do NOT generate):\n'
            f'["Works at Company X", "Experienced professional"]\n\n'
            f'If emails are very limited, extract at least: their role/company, frequency of communication, any project names mentioned.',
            email_data_for_synthesis,
            700
        )

        if local_synthesis:
            logger.info(
                f'Raw email synthesis result',
                requestId=request_id,
                attendeeEmail=attendee_email,
                synthesisLength=len(local_synthesis),
                synthesisRaw=local_synthesis[:500]
            )

            try:
                parsed = safe_parse_json(local_synthesis)
                logger.info(
                    f'Email synthesis parse result',
                    requestId=request_id,
                    attendeeEmail=attendee_email,
                    parsedType=type(parsed).__name__,
                    isArray=isinstance(parsed, list),
                    parsedLength=len(parsed) if isinstance(parsed, list) else 'N/A',
                    parsedSample=parsed[0] if isinstance(parsed, list) and parsed else parsed
                )

                if isinstance(parsed, list) and parsed:
                    # Handle both string arrays and object arrays with "fact" property
                    key_facts = [
                        f if isinstance(f, str) else (f.get('fact') if isinstance(f, dict) and 'fact' in f else (f.get('text') if isinstance(f, dict) and 'text' in f else None))
                        for f in parsed
                    ]
                    key_facts = [f for f in key_facts if f and isinstance(f, str) and len(f) > 10]
                    logger.info(
                        f'    ✓ Extracted {len(key_facts)} facts from emails',
                        requestId=request_id,
                        attendeeEmail=attendee_email,
                        factCount=len(key_facts),
                        sampleFacts=key_facts[:2] if key_facts else []
                    )
                else:
                    logger.warn(
                        f'Email synthesis returned empty or invalid array',
                        requestId=request_id,
                        attendeeEmail=attendee_email,
                        parsed=parsed,
                        rawSynthesis=local_synthesis[:300]
                    )
                    logger.info(f'    ⚠️  Email synthesis returned empty array', requestId=request_id)
                    if fallback_facts:
                        key_facts = fallback_facts
                        logger.info(f'    ✓ Using {len(fallback_facts)} fallback facts from email metadata', requestId=request_id)
            except Exception as e:
                logger.error(
                    f'Failed to parse email synthesis',
                    requestId=request_id,
                    attendeeEmail=attendee_email,
                    error=str(e),
                    errorStack=str(e.__traceback__),
                    synthesis=local_synthesis[:500]
                )
                logger.info(f'    ⚠️  Failed to parse email synthesis: {str(e)}', requestId=request_id)
                if fallback_facts:
                    key_facts = fallback_facts
                    logger.info(f'    ✓ Using {len(fallback_facts)} fallback facts from email metadata', requestId=request_id)
        else:
            logger.warn(f'Email synthesis returned null', requestId=request_id, attendeeEmail=attendee_email)
            logger.info(f'    ⚠️  Email synthesis returned null', requestId=request_id)
            if fallback_facts:
                key_facts = fallback_facts
                logger.info(f'    ✓ Using {len(fallback_facts)} fallback facts from email metadata', requestId=request_id)

    # Web search via Parallel API
    results_to_use = []

    if parallel_client:
        logger.info(f'    🌐 Performing web search...', requestId=request_id)
        try:
            queries = [
                f'"{name}" site:linkedin.com {domain}',
                *([f'"{name}" {company} site:linkedin.com'] if company else []),
                f'"{name}" "{attendee_email}"'
            ]

            search_result = await parallel_client.beta.search(
                objective=f'Find LinkedIn profile and professional info for {name}{" who works at " + company if company else ""} ({attendee_email})',
                search_queries=queries,
                max_results=8,
                max_chars_per_result=2500
            )

            if search_result.get('results'):
                # Filter and validate results
                company_name_only = company.lower() if company else None
                name_lower = name.lower()
                name_words = [w for w in name.split(' ') if len(w) > 2]

                validated_results = []
                for r in search_result['results']:
                    text_to_search = f'{r.get("title", "")} {r.get("excerpt", "")} {r.get("url", "")}'.lower()

                    # Person validation: check if name appears in result
                    name_match = any(word.lower() in text_to_search for word in name_words) if name_words else False

                    # Company/email match (only if company is available)
                    company_match = company_name_only and company_name_only in text_to_search if company_name_only else False
                    email_match = attendee_email.lower() in text_to_search

                    # Require name match OR (company/email match)
                    if name_match or (company_match or email_match):
                        validated_results.append(r)

                # If no validated results, try less strict (name only)
                if not validated_results:
                    relevant_results = [
                        r for r in search_result['results']
                        if any(word.lower() in f'{r.get("title", "")} {r.get("excerpt", "")} {r.get("url", "")}'.lower()
                               for word in name_words)
                    ]
                else:
                    relevant_results = validated_results

                # Fallback to all results if still empty
                results_to_use = relevant_results if relevant_results else search_result['results'][:3]

                if results_to_use:
                    logger.info(f'    ✓ Found {len(results_to_use)} relevant web results', requestId=request_id)

                    logger.info(
                        f'Synthesizing web search results',
                        requestId=request_id,
                        attendeeEmail=attendee_email,
                        resultCount=len(results_to_use)
                    )

                    user_context_str = ''
                    if user_context:
                        user_context_str = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). '

                    web_synthesis = await synthesize_results(
                        f'{user_context_str}Extract professional information about {name} ({attendee_email}) for meeting "{meeting_title}"{meeting_date_context}. Focus on information that {"the user" if not user_context else user_context["formattedName"]} should know about this attendee\'s role and background.\n\n'
                        f'CRITICAL OUTPUT FORMAT: Return ONLY a valid JSON array. No markdown code blocks, no explanations, no narrative text. Just the JSON array.\n\n'
                        f'EXAMPLE FORMAT:\n'
                        f'["Fact 1 about their role or background", "Fact 2 about their work or expertise", "Fact 3 about relevant experience"]\n\n'
                        f'REQUIREMENTS:\n'
                        f'- Return at least 1-2 facts even if information is limited\n'
                        f'- Each fact should be 15-80 words\n'
                        f'- Focus on: current role, company, expertise, relevant background, LinkedIn profile highlights\n'
                        f'- Extract ANY relevant professional information that would help {"the user" if not user_context else user_context["formattedName"]} understand this attendee\n\n'
                        f'Return JSON array of 3-6 facts (15-80 words each).',
                        results_to_use[:5],
                        600
                    )

                    if web_synthesis:
                        logger.info(
                            f'Raw web synthesis result',
                            requestId=request_id,
                            attendeeEmail=attendee_email,
                            synthesisLength=len(web_synthesis),
                            synthesisRaw=web_synthesis[:500]
                        )

                        try:
                            web_parsed = safe_parse_json(web_synthesis)
                            logger.info(
                                f'Web synthesis parse result',
                                requestId=request_id,
                                attendeeEmail=attendee_email,
                                parsedType=type(web_parsed).__name__,
                                isArray=isinstance(web_parsed, list),
                                parsedLength=len(web_parsed) if isinstance(web_parsed, list) else 'N/A',
                                parsedSample=web_parsed[0] if isinstance(web_parsed, list) and web_parsed else web_parsed
                            )

                            if isinstance(web_parsed, list) and web_parsed:
                                # Handle both string arrays and object arrays with "fact" property
                                new_facts = [
                                    f if isinstance(f, str) else (f.get('fact') if isinstance(f, dict) and 'fact' in f else (f.get('text') if isinstance(f, dict) and 'text' in f else None))
                                    for f in web_parsed
                                ]
                                new_facts = [f for f in new_facts if f and isinstance(f, str) and len(f) > 10]
                                key_facts.extend(new_facts)
                                source = 'local+web' if key_facts else 'web'
                                logger.info(
                                    f'    ✓ Extracted {len(new_facts)} facts from web search',
                                    requestId=request_id,
                                    attendeeEmail=attendee_email,
                                    webFactCount=len(new_facts),
                                    totalFactCount=len(key_facts),
                                    sampleWebFacts=new_facts[:2] if new_facts else []
                                )
                            else:
                                logger.warn(
                                    f'Web synthesis returned empty or invalid array',
                                    requestId=request_id,
                                    attendeeEmail=attendee_email,
                                    parsed=web_parsed,
                                    rawSynthesis=web_synthesis[:300]
                                )
                                logger.info(f'    ⚠️  Web synthesis returned empty array', requestId=request_id)
                        except Exception as e:
                            logger.error(
                                f'Failed to parse web synthesis',
                                requestId=request_id,
                                attendeeEmail=attendee_email,
                                error=str(e),
                                errorStack=str(e.__traceback__),
                                synthesis=web_synthesis[:500]
                            )
                            logger.info(f'    ⚠️  Could not parse web results: {str(e)}', requestId=request_id)
                    else:
                        logger.warn(f'Web synthesis returned null', requestId=request_id, attendeeEmail=attendee_email)
                        logger.info(f'    ⚠️  Web synthesis returned null', requestId=request_id)
        except Exception as web_error:
            logger.error(f'    ⚠️  Web search failed: {str(web_error)}', requestId=request_id)

    # Ensure keyFacts is always an array and has at least basic info if empty
    final_key_facts = key_facts[:6]

    # Fallback: If no keyFacts found, add basic information
    if not final_key_facts:
        if company:
            final_key_facts = [
                f'Works at {company} ({domain})',
                f'Email: {attendee_email}'
            ]
        elif is_educational_domain:
            final_key_facts = [
                f'Student at {domain}',
                f'Email: {attendee_email}'
            ]
        else:
            final_key_facts = [f'Email: {attendee_email}']
        source = 'basic'

    # Separate email facts from web facts for extraction data
    web_facts_count = len(results_to_use) if results_to_use else 0
    email_facts = key_facts[:-web_facts_count] if web_facts_count > 0 and len(key_facts) > web_facts_count else key_facts
    web_facts = key_facts[-web_facts_count:] if web_facts_count > 0 and len(key_facts) >= web_facts_count else []
    
    attendee_result = {
        'name': name,
        'email': attendee_email,
        'company': company,
        'title': title or (f'{company} team member' if company else ('Student' if is_educational_domain else 'Unknown')),
        'keyFacts': final_key_facts,
        'dataSource': source,
        '_extractionData': {
            'emailsFrom': len(attendee_emails),
            'emailsTo': len(emails_to_attendee),
            'emailData': email_data_for_synthesis[:10],
            'webSearchResults': results_to_use or [],
            'emailFacts': email_facts,
            'webFacts': web_facts
        }
    }
    
    logger.info(
        f'  ✅ Completed research for {name} ({attendee_email})',
        requestId=request_id,
        attendeeEmail=attendee_email,
        totalFacts=len(final_key_facts),
        emailFacts=len(email_facts),
        webFacts=len(web_facts),
        source=source,
        hasCompany=bool(company),
        hasTitle=bool(title)
    )

    return attendee_result


async def research_attendees(
    attendees: List[Dict[str, Any]],
    emails: List[Dict[str, Any]],
    calendar_events: List[Dict[str, Any]],
    meeting_title: str,
    meeting_date_context: str,
    user_context: Optional[Dict[str, Any]] = None,
    parallel_client: Optional[Any] = None,
    request_id: str = 'unknown'
) -> List[Dict[str, Any]]:
    """
    Research multiple attendees in parallel
    
    Args:
        attendees: List of attendee objects to research
        emails: All emails in context
        calendar_events: Calendar events for context
        meeting_title: Meeting title
        meeting_date_context: Meeting date context string
        user_context: User context object
        parallel_client: Parallel AI client for web search
        request_id: Request ID for logging
    Returns:
        List of researched attendee objects with keyFacts and extraction data
    """
    logger.info(
        f'Researching {len(attendees)} attendees',
        requestId=request_id,
        attendeeCount=len(attendees),
        emailCount=len(emails),
        calendarEventCount=len(calendar_events),
        hasParallelClient=bool(parallel_client)
    )
    
    # Research all attendees in parallel
    research_tasks = [
        _research_single_attendee(
            attendee, emails, calendar_events, meeting_title,
            meeting_date_context, user_context, parallel_client, request_id
        )
        for attendee in attendees
    ]
    
    results = await asyncio.gather(*research_tasks, return_exceptions=True)
    
    # Filter out None results and exceptions
    researched_attendees = []
    failed_count = 0
    for i, r in enumerate(results):
        if isinstance(r, Exception):
            logger.error(
                f'Attendee research failed for attendee {i}',
                requestId=request_id,
                error=str(r),
                attendee=attendees[i] if i < len(attendees) else None
            )
            failed_count += 1
        elif r is not None:
            researched_attendees.append(r)
    
    logger.info(
        f'  ✅ Completed attendee research',
        requestId=request_id,
        totalAttendees=len(attendees),
        successful=len(researched_attendees),
        failed=failed_count,
        totalFacts=sum(len(att.get('keyFacts', [])) for att in researched_attendees),
        avgFactsPerAttendee=round(sum(len(att.get('keyFacts', [])) for att in researched_attendees) / len(researched_attendees), 1) if researched_attendees else 0
    )
    
    return researched_attendees

