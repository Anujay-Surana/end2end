"""
Meeting Brief Analyzer Service

Transforms raw context data (emails, files, calendar events) into
AI-analyzed meeting intelligence using GPT-4.1-mini.

Features:
- Parallel processing of independent analyses
- Error handling with graceful fallbacks
- Token optimization (summarization for large contexts)
- Cost tracking and logging
"""

import json
import re
import asyncio
from typing import Dict, List, Any, Optional
from app.services.gpt_service import call_gpt, synthesize_results, safe_parse_json, craft_search_queries
from app.services.logger import logger
from app.services.utils import get_meeting_datetime


class BriefAnalyzer:
    def __init__(self, openai_api_key: str, parallel_client=None):
        self.openai_api_key = openai_api_key
        self.parallel_client = parallel_client
        self.cost_tracker = {'totalTokens': 0, 'estimatedCost': 0.0}

    async def analyze(self, context: Dict[str, Any], options: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        Main entry point: Analyze all context and return complete brief
        """
        if options is None:
            options = {}
        
        meeting = context.get('meeting')
        attendees = context.get('attendees', [])
        emails = context.get('emails', [])
        files = context.get('files', [])
        calendar_events = context.get('calendarEvents', [])

        include_web_research = options.get('includeWebResearch', False)
        max_tokens_per_call = options.get('maxTokensPerCall', 8000)

        logger.info(
            f"\n🧠 Starting AI analysis of meeting brief...",
            emails=len(emails) if emails else 0,
            files=len(files) if files else 0,
            calendar=len(calendar_events) if calendar_events else 0
        )

        try:
            # PARALLELIZATION: All independent analyses run simultaneously
            attendees_analysis, email_analysis, document_analysis, relationship_analysis, timeline = await asyncio.gather(
                self.analyze_attendees(attendees, emails, files, include_web_research),
                self.analyze_emails(emails),
                self.analyze_documents(files),
                self.analyze_relationships(attendees, emails, calendar_events),
                self.build_timeline(emails, files, calendar_events)
            )

            # PARALLELIZATION: All dependent analyses run simultaneously after independent ones complete
            summary, recommendations, action_items, company_research = await asyncio.gather(
                self.generate_summary(meeting, {
                    'attendeesAnalysis': attendees_analysis,
                    'emailAnalysis': email_analysis,
                    'documentAnalysis': document_analysis,
                    'relationshipAnalysis': relationship_analysis
                }),
                self.generate_recommendations(meeting, {
                    'attendeesAnalysis': attendees_analysis,
                    'emailAnalysis': email_analysis,
                    'documentAnalysis': document_analysis,
                    'relationshipAnalysis': relationship_analysis
                }),
                self.generate_action_items(meeting, {
                    'attendeesAnalysis': attendees_analysis,
                    'emailAnalysis': email_analysis,
                    'documentAnalysis': document_analysis
                }),
                self.research_companies_with_parallel(attendees_analysis, meeting)
            )

            # Compile final brief
            brief = {
                'success': True,
                'summary': summary,
                'attendees': attendees_analysis,
                'relationshipAnalysis': relationship_analysis,
                'timeline': timeline,
                'emailAnalysis': email_analysis,
                'documentAnalysis': document_analysis,
                'companyResearch': company_research,
                'recommendations': recommendations,
                'actionItems': action_items,
                'context': {
                    'emails': emails,
                    'files': files,
                    'calendarEvents': calendar_events,
                    'meeting': meeting,
                    'attendees': attendees
                },
                '_analysisMetadata': {
                    'generatedAt': self._get_iso_timestamp(),
                    'tokensUsed': self.cost_tracker['totalTokens'],
                    'estimatedCost': self.cost_tracker['estimatedCost'],
                    'webResearchIncluded': include_web_research
                }
            }

            logger.info(
                f"✅ AI analysis complete!",
                tokensUsed=self.cost_tracker['totalTokens'],
                estimatedCost=f"${self.cost_tracker['estimatedCost']:.4f}"
            )

            return brief

        except Exception as error:
            logger.error(f'❌ Error during AI analysis: {str(error)}')
            raise Exception(f'Brief analysis failed: {str(error)}')

    async def analyze_attendees(self, attendees: List[Dict[str, Any]], emails: List[Dict[str, Any]], 
                                files: List[Dict[str, Any]], include_web_research: bool) -> List[Dict[str, Any]]:
        """Analyze attendees and extract key facts"""
        if not attendees or len(attendees) == 0:
            return []

        logger.info(f"   📊 Analyzing {len(attendees)} attendees...")

        # PARALLELIZATION: Process all attendees simultaneously
        attendee_promises = [self._analyze_single_attendee(att, emails, files, include_web_research) for att in attendees]
        analyzed_attendees = await asyncio.gather(*attendee_promises, return_exceptions=True)

        # Filter out exceptions and return valid results
        results = []
        for i, result in enumerate(analyzed_attendees):
            if isinstance(result, Exception):
                logger.error(f"   ⚠️  Error analyzing attendee {attendees[i].get('email', 'unknown')}: {str(result)}")
                # Return fallback attendee
                att = attendees[i]
                results.append({
                    'name': att.get('displayName') or att.get('name') or att.get('email'),
                    'email': att.get('email'),
                    'title': '',
                    'company': self.extract_company(att),
                    'keyFacts': [],
                    'organizer': att.get('organizer', False)
                })
            else:
                results.append(result)

        logger.info(f"   ✅ Attendee analysis complete")
        return results

    async def _analyze_single_attendee(self, attendee: Dict[str, Any], emails: List[Dict[str, Any]], 
                                      files: List[Dict[str, Any]], include_web_research: bool) -> Dict[str, Any]:
        """Analyze a single attendee"""
        try:
            name = attendee.get('displayName') or attendee.get('name') or attendee.get('email')
            email = attendee.get('email')
            company = self.extract_company(attendee)

            logger.info(f"   🔍 Researching {name}...")

            # Build context for this attendee
            attendee_context = self.build_attendee_context(attendee, emails or [], files or [])

            key_facts = []
            title = ''

            # Web research if enabled
            if include_web_research and self.parallel_client:
                try:
                    search_queries = await craft_search_queries(
                        f"Research attendee: {name} ({email}, {company})\n\n"
                        f"Generate 3 highly specific web search queries to find:\n"
                        f"1. Professional background (LinkedIn, company website, professional profiles)\n"
                        f"2. Recent activities, announcements, or publications\n"
                        f"3. Role, title, and expertise areas\n\n"
                        f"Focus on verifiable, recent information that would be useful for meeting preparation."
                    )

                    if len(search_queries) > 0:
                        # Execute all search queries in parallel
                        search_results = []
                        search_promises = []
                        for query in search_queries:
                            async def search_query(q):
                                try:
                                    result = await self.parallel_client.beta.search(
                                        objective=q,
                                        search_queries=[q],
                                        max_results=8,
                                        max_chars_per_result=3000
                                    )
                                    if result and result.get('results'):
                                        return result['results']
                                    return []
                                except Exception as e:
                                    logger.error(f"   ⚠️  Search failed: {q[:50]}... {str(e)}")
                                    return []

                            search_promises.append(search_query(query))

                        search_results_lists = await asyncio.gather(*search_promises, return_exceptions=True)
                        for results_list in search_results_lists:
                            if isinstance(results_list, list):
                                search_results.extend(results_list)

                        # Extract title from web results
                        if search_results:
                            title = self.extract_title_from_web_results(search_results, name)

                        # Synthesize key facts from web results + email/file context
                        if search_results:
                            combined_context = f"""
Web Research Results:
{json.dumps(search_results)[:15000]}

Email Context:
{attendee_context['emailContext']}

Document Context:
{attendee_context['documentContext']}
"""

                            synthesized = await synthesize_results(
                                f"Extract 3-5 key facts about {name} that would be valuable for meeting preparation.\n"
                                f"Focus on:\n"
                                f"- Current role and title\n"
                                f"- Professional background and expertise\n"
                                f"- Recent activities or achievements\n"
                                f"- Relevant projects or initiatives\n\n"
                                f"Return information that would be genuinely useful in a business meeting context.",
                                combined_context,
                                600
                            )

                            if synthesized:
                                # Convert synthesized paragraph into bullet points
                                key_facts = [
                                    s.strip() for s in re.split(r'[.!?]+', synthesized)
                                    if len(s.strip()) > 15 and len(s.strip()) < 200
                                ][:5]

                except Exception as web_error:
                    logger.error(f"   ⚠️  Web research failed for {name}: {str(web_error)}")

            # Fallback: If no web research or web research failed, use email/file context only
            if len(key_facts) == 0:
                try:
                    context_facts = await call_gpt([{
                        'role': 'system',
                        'content': 'You are an expert meeting preparation analyst. Extract 3-5 key facts about this attendee from the provided context. Return ONLY a JSON array of strings, nothing else.'
                    }, {
                        'role': 'user',
                        'content': f"""Attendee: {name}
Email: {email}
Organization: {company}

Email Context:
{attendee_context['emailContext']}

Document Context:
{attendee_context['documentContext']}

Extract 3-5 key facts as a JSON array of strings."""
                    }], 500)

                    parsed = safe_parse_json(context_facts)
                    if isinstance(parsed, list):
                        key_facts = parsed
                    elif isinstance(parsed, dict) and 'items' in parsed:
                        key_facts = parsed['items']
                except Exception as e:
                    logger.error(f"   ⚠️  Context analysis failed for {name}: {str(e)}")
                    key_facts = []

            logger.info(f"   ✅ {name}: {len(key_facts)} facts, title: \"{title or 'N/A'}\"")

            return {
                'name': name,
                'email': email,
                'title': title or '',
                'company': company,
                'keyFacts': key_facts or [],
                'organizer': attendee.get('organizer', False)
            }

        except Exception as error:
            logger.error(f"   ⚠️  Error analyzing attendee {attendee.get('email')}: {str(error)}")
            return {
                'name': attendee.get('displayName') or attendee.get('name') or attendee.get('email'),
                'email': attendee.get('email'),
                'title': '',
                'company': self.extract_company(attendee),
                'keyFacts': [],
                'organizer': attendee.get('organizer', False)
            }

    async def analyze_emails(self, emails: List[Dict[str, Any]]) -> str:
        """Analyze email threads"""
        if not emails or len(emails) == 0:
            return 'No recent email activity to analyze.'

        logger.info(f"   📧 Analyzing {len(emails)} emails...")

        try:
            # Sort by date and take most recent 10 emails
            recent_emails = sorted(
                emails,
                key=lambda e: self._parse_date(e.get('date', '')),
                reverse=True
            )[:10]

            # Summarize email content
            email_summaries = []
            for idx, email in enumerate(recent_emails):
                body = email.get('body') or email.get('snippet') or ''
                truncated_body = body[:500]
                email_summaries.append(f"""Email {idx + 1}:
Subject: {email.get('subject', 'No subject')}
From: {email.get('from', 'Unknown')}
To: {email.get('to', 'Unknown')}
Date: {email.get('date', 'Unknown')}
Content: {truncated_body}
---""")

            email_text = '\n\n'.join(email_summaries)

            analysis = await synthesize_results(
                """Analyze these email threads and extract key themes, decisions, and action items discussed.
Return a 2-3 sentence paragraph summarizing:
- Main topics discussed
- Important decisions or agreements
- Outstanding questions or action items""",
                email_text,
                300
            )

            logger.info(f"   ✅ Email analysis complete")
            return analysis or 'Unable to extract meaningful insights from email threads.'

        except Exception as error:
            logger.error(f"   ⚠️  Error analyzing emails: {str(error)}")
            return 'Unable to analyze emails due to processing error.'

    async def analyze_documents(self, files: List[Dict[str, Any]]) -> str:
        """Analyze documents"""
        if not files or len(files) == 0:
            return 'No relevant documents identified.'

        logger.info(f"   📄 Analyzing {len(files)} documents...")

        try:
            # Filter files with content
            files_with_content = [
                f for f in files
                if (f.get('hasContent') or f.get('content')) and f.get('content')
            ]
            files_with_content.sort(
                key=lambda f: self._parse_date(f.get('modifiedTime', '')),
                reverse=True
            )
            files_with_content = files_with_content[:3]

            if len(files_with_content) == 0:
                # For files without content, infer relevance from metadata
                file_metadata = '\n'.join([
                    f"{f.get('name', 'Unknown')} ({f.get('mimeType', 'Unknown')}, modified: {f.get('modifiedTime', 'Unknown')})"
                    for f in files[:10]
                ])

                analysis = await synthesize_results(
                    """Based on these document titles and metadata, infer what materials are relevant for this meeting.
Return a 2-3 sentence paragraph describing:
- What these documents likely contain
- How they relate to the meeting topic
- What to review or prepare from them""",
                    file_metadata,
                    300
                )

                return analysis or 'Documents found but no readable content available.'

            # For files WITH content, do deep analysis
            doc_summaries = []
            for idx, file in enumerate(files_with_content):
                content = file.get('content', '')[:8000]
                doc_summaries.append(f"""Document {idx + 1}:
Name: {file.get('name', 'Unknown')}
Type: {file.get('mimeType', 'Unknown')}
Owner: {file.get('owner', 'Unknown')}
Last Modified: {file.get('modifiedTime', 'Unknown')}
Content:
{content}
---""")

            doc_text = '\n\n'.join(doc_summaries)

            analysis = await synthesize_results(
                """Analyze these documents deeply and extract:
- Key insights and main points
- Decisions made or proposed
- Action items and next steps

Return a 2-3 sentence paragraph.""",
                doc_text,
                400
            )

            logger.info(f"   ✅ Document analysis complete")
            return analysis or 'Unable to extract insights from documents.'

        except Exception as error:
            logger.error(f"   ⚠️  Error analyzing documents: {str(error)}")
            return 'Unable to analyze documents due to processing error.'

    async def analyze_relationships(self, attendees: List[Dict[str, Any]], emails: List[Dict[str, Any]], 
                                   calendar_events: List[Dict[str, Any]]) -> str:
        """Analyze relationships and dynamics"""
        if not attendees or len(attendees) == 0:
            return 'No attendee information available for relationship analysis.'

        logger.info(f"   🤝 Analyzing relationships...")

        try:
            # Build relationship context
            attendee_list = '\n'.join([
                f"{att.get('displayName') or att.get('name') or att.get('email')} ({att.get('email')})"
                f"{' [ORGANIZER]' if att.get('organizer') else ''}"
                for att in attendees
            ])

            # Count interactions per attendee
            interaction_counts = self.count_interactions(attendees, emails or [], calendar_events or [])

            # Recent email patterns
            recent_email_patterns = self.analyze_email_patterns(attendees, emails or [])

            analysis = await call_gpt([{
                'role': 'system',
                'content': """You are an expert in professional relationship dynamics. Analyze attendee relationships and provide insights on:
1. Working relationship patterns and history
2. Power dynamics and decision-making influence
3. Communication styles and preferences

Be tactful and professional."""
            }, {
                'role': 'user',
                'content': f"""Attendees:
{attendee_list}

Interaction Summary:
{interaction_counts}

Recent Email Patterns:
{recent_email_patterns}

Email History: {len(emails) if emails else 0} emails
Calendar History: {len(calendar_events) if calendar_events else 0} past meetings

Analyze the relationship dynamics."""
            }], 1000)

            logger.info(f"   ✅ Relationship analysis complete")
            return analysis

        except Exception as error:
            logger.error(f"   ⚠️  Error analyzing relationships: {str(error)}")
            return 'Unable to analyze relationships due to processing error.'

    def build_timeline(self, emails: List[Dict[str, Any]], files: List[Dict[str, Any]], 
                      calendar_events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Build chronological timeline"""
        logger.info(f"   📅 Building timeline...")

        timeline = []

        # Add emails to timeline
        if emails:
            for email in emails:
                if not isinstance(email, dict):
                    continue
                timeline.append({
                    'type': 'email',
                    'date': self._parse_date(email.get('date', '')),
                    'subject': email.get('subject', 'No subject'),
                    'participants': [email.get('from'), email.get('to')],
                    'snippet': (email.get('body') or email.get('snippet') or '')[:200]
                })

        # Add documents to timeline
        if files:
            for file in files:
                if not isinstance(file, dict):
                    continue
                timeline.append({
                    'type': 'document',
                    'date': file.get('modifiedTime') or file.get('createdTime', ''),
                    'name': file.get('name', 'Unknown'),
                    'action': 'modified' if file.get('modifiedTime') else 'created',
                    'participants': [file.get('owner')] if file.get('owner') else []
                })

        # Add calendar events to timeline
        if calendar_events:
            for event in calendar_events:
                if not isinstance(event, dict):
                    continue
                event_start_obj = event.get('start')
                if isinstance(event_start_obj, dict):
                    event_date_str = event_start_obj.get('dateTime') or event_start_obj.get('date')
                else:
                    event_date_str = event_start_obj
                timeline.append({
                    'type': 'meeting',
                    'date': event_date_str or '',
                    'subject': event.get('summary', 'Untitled'),
                    'participants': [a.get('email') for a in (event.get('attendees') or []) if isinstance(a, dict)]
                })

        # Sort by date (most recent first)
        timeline.sort(key=lambda x: self._parse_date(x.get('date', '')), reverse=True)

        # Limit to 50 most recent events
        limited_timeline = timeline[:50]

        logger.info(f"   ✅ Timeline built: {len(limited_timeline)} events")
        return limited_timeline

    async def generate_summary(self, meeting: Dict[str, Any], analyses: Dict[str, Any]) -> str:
        """Generate executive summary"""
        logger.info(f"   📝 Generating executive summary...")

        try:
            summary = await call_gpt([{
                'role': 'system',
                'content': """You are an executive assistant creating a brief, powerful meeting summary. Write 2-3 sentences that capture the essence of this meeting and what the user needs to know. Focus on what's actionable and decision-critical."""
            }, {
                'role': 'user',
                'content': f"""Meeting: {meeting.get('summary') if meeting else 'Upcoming Meeting'}
Time: {get_meeting_datetime(meeting, 'start') if meeting else 'Not specified'}
Attendees: {', '.join([a.get('name', 'Unknown') for a in (analyses.get('attendeesAnalysis') or [])]) if analyses.get('attendeesAnalysis') else 'Not specified'}

Context Analysis:
- Email Analysis: {(analyses.get('emailAnalysis') or '')[:300]}
- Document Analysis: {(analyses.get('documentAnalysis') or '')[:300]}
- Relationship Analysis: {(analyses.get('relationshipAnalysis') or '')[:300]}

Generate a powerful 2-3 sentence executive summary."""
            }], 200)

            logger.info(f"   ✅ Summary generated")
            return summary

        except Exception as error:
            logger.error(f"   ⚠️  Error generating summary: {str(error)}")
            return f"Meeting with {len(analyses.get('attendeesAnalysis') or [])} attendees."

    async def generate_recommendations(self, meeting: Dict[str, Any], analyses: Dict[str, Any]) -> List[str]:
        """Generate strategic recommendations"""
        logger.info(f"   💡 Generating recommendations...")

        try:
            recommendations_result = await synthesize_results(
                """Based on all the meeting context, provide 3-5 strategic recommendations or discussion points.

Consider:
- Attendee backgrounds and expertise
- Recent email discussions
- Company context
- Meeting objectives

Return ONLY a JSON array of recommendation strings. Each should be:
- Specific and actionable
- Tailored to this specific meeting
- 20-60 words
- Strategic rather than tactical

Example:
["Leverage Susannah's life sciences expertise to discuss healthcare AI applications, referencing her recent SPC blog post", "Propose pilot program with Kordn8's MVP, addressing the prototype limitations mentioned in recent reports"]

Return ONLY the JSON array.""",
                {
                    'meeting': {'title': meeting.get('summary') if meeting else None, 'description': meeting.get('description') if meeting else None},
                    'attendees': analyses.get('attendeesAnalysis') or [],
                    'emailAnalysis': analyses.get('emailAnalysis'),
                    'documentAnalysis': analyses.get('documentAnalysis'),
                    'relationshipAnalysis': analyses.get('relationshipAnalysis')
                },
                500
            )

            # Parse with fallback logic
            parsed_recommendations = []
            try:
                clean_recs = recommendations_result.replace('```json', '').replace('```', '').strip()
                parsed = safe_parse_json(clean_recs)
                if isinstance(parsed, list):
                    parsed_recommendations = parsed[:5]
                elif isinstance(parsed, dict):
                    parsed_recommendations = parsed.get('items', parsed.get('recommendations', []))[:5]
            except Exception as e:
                logger.warning(f"   ⚠️  Failed to parse recommendations JSON, using fallback: {str(e)}")
                # Fallback: split by newlines/bullets
                if recommendations_result:
                    parsed_recommendations = [
                        r.strip().replace(re.match(r'^[\d\.\)]+\s*', r.strip()).group(0), '') if re.match(r'^[\d\.\)]+\s*', r.strip()) else r.strip()
                        for r in re.split(r'[\n•\-]', recommendations_result)
                        if r.strip() and len(r.strip()) > 20
                    ][:5]

            logger.info(f"   ✅ Recommendations generated: {len(parsed_recommendations)}")
            return parsed_recommendations

        except Exception as error:
            logger.error(f"   ⚠️  Error generating recommendations: {str(error)}")
            return ['Review meeting agenda', 'Prepare questions for attendees']

    async def generate_action_items(self, meeting: Dict[str, Any], analyses: Dict[str, Any]) -> List[str]:
        """Generate action items"""
        logger.info(f"   ✅ Generating action items...")

        try:
            attendees_summary = ', '.join([
                f"{a.get('name', 'Unknown')} ({a.get('title', 'Unknown')})"
                for a in (analyses.get('attendeesAnalysis') or [])
            ]) or 'N/A'

            action_result = await synthesize_results(
                f"""Based on this meeting information, suggest 3-5 specific action items to prepare effectively.

Meeting: {meeting.get('summary') if meeting else 'Upcoming Meeting'}
Attendees: {attendees_summary}

Return ONLY a JSON array of actionable preparation steps. Each item should be:
- Specific and concrete (what to review, prepare, or research)
- Actionable before the meeting
- Relevant to the attendees and context
- 10-40 words

Example format:
["Review Q3 sales metrics and prepare comparison with Q2 targets", "Research competitor pricing models mentioned in John's last email", "Prepare technical architecture diagram for the new API integration"]

Return ONLY the JSON array, no other text.""",
                {
                    'meeting': meeting,
                    'attendees': analyses.get('attendeesAnalysis') or [],
                    'emailAnalysis': analyses.get('emailAnalysis'),
                    'documentAnalysis': analyses.get('documentAnalysis')
                },
                400
            )

            # Parse with fallback logic
            parsed_action_items = []
            try:
                clean_action = action_result.replace('```json', '').replace('```', '').strip()
                parsed = safe_parse_json(clean_action)
                if isinstance(parsed, list):
                    parsed_action_items = [
                        item for item in parsed
                        if isinstance(item, str) and len(item) > 10
                    ][:5]
                elif isinstance(parsed, dict):
                    parsed_action_items = parsed.get('items', parsed.get('actionItems', []))[:5]
            except Exception as e:
                logger.warning(f"   ⚠️  Failed to parse action items JSON, using fallback: {str(e)}")
                # Fallback parsing
                if action_result:
                    parsed_action_items = [
                        a.strip().replace(re.match(r'^[\d\.\)]+\s*', a.strip()).group(0), '') if re.match(r'^[\d\.\)]+\s*', a.strip()) else a.strip()
                        for a in re.split(r'[\n•\-]', action_result)
                        if a.strip() and len(a.strip()) > 10
                    ][:5]

            logger.info(f"   ✅ Action items generated: {len(parsed_action_items)}")
            return parsed_action_items

        except Exception as error:
            logger.error(f"   ⚠️  Error generating action items: {str(error)}")
            return ['Review meeting agenda', 'Confirm attendance']

    async def research_companies_with_parallel(self, attendees_analysis: List[Dict[str, Any]], 
                                               meeting: Dict[str, Any]) -> str:
        """Research companies using Parallel API"""
        if not attendees_analysis or len(attendees_analysis) == 0:
            return 'No company information available.'

        # Extract unique companies
        companies = {}
        for att in attendees_analysis:
            company = att.get('company')
            if company:
                if company not in companies:
                    companies[company] = []
                companies[company].append(att.get('name'))

        if len(companies) == 0:
            return 'No company information available.'

        # If no Parallel API, just list companies
        if not self.parallel_client:
            return '\n'.join([
                f"{company}: {', '.join(people)}"
                for company, people in companies.items()
            ])

        try:
            logger.info(f"   🌐 Researching {len(companies)} companies with Parallel API...")

            company_list = ', '.join(companies.keys())

            # Craft search queries
            search_queries = await craft_search_queries(
                f"""Meeting: {meeting.get('summary') if meeting else 'Business Meeting'}
Companies: {company_list}

Generate 3 highly specific web search queries to find:
1. Recent company news, announcements, or press releases
2. Funding rounds, acquisitions, or business developments
3. Product launches, partnerships, or strategic initiatives

Focus on recent (last 6 months) verifiable information."""
            )

            if len(search_queries) == 0:
                logger.info(f"   ⚠️  No search queries generated for companies")
                return '\n'.join([
                    f"{company}: {', '.join(people)}"
                    for company, people in companies.items()
                ])

            # Execute all company search queries simultaneously
            search_results = []
            search_promises = []
            for query in search_queries:
                async def search_query(q):
                    try:
                        result = await self.parallel_client.beta.search(
                            objective=q,
                            search_queries=[q],
                            max_results=4,
                            max_chars_per_result=2000
                        )
                        if result and result.get('results'):
                            return result['results']
                        return []
                    except Exception as e:
                        logger.error(f"   ⚠️  Company search failed: {q[:50]}... {str(e)}")
                        return []

                search_promises.append(search_query(query))

            search_results_lists = await asyncio.gather(*search_promises, return_exceptions=True)
            for results_list in search_results_lists:
                if isinstance(results_list, list):
                    search_results.extend(results_list)

            if len(search_results) == 0:
                logger.info(f"   ⚠️  No company search results found")
                return '\n'.join([
                    f"{company}: {', '.join(people)}"
                    for company, people in companies.items()
                ])

            # Synthesize company research
            research = await synthesize_results(
                """Analyze these company search results and extract key business intelligence relevant for the meeting.

Focus on:
- Recent company news, announcements, or developments (last 6 months)
- Funding rounds, acquisitions, partnerships, or strategic initiatives
- Product launches or major feature releases

Return a well-structured summary (2-3 sentences per company) that provides actionable intelligence for meeting preparation.""",
                json.dumps(search_results)[:8000],
                500
            )

            logger.info(f"   ✅ Company research synthesized")
            return research or 'No significant company developments found.'

        except Exception as error:
            logger.error(f"   ⚠️  Company research error: {str(error)}")
            return '\n'.join([
                f"{company}: {', '.join(people)}"
                for company, people in companies.items()
            ])

    def build_attendee_context(self, attendee: Dict[str, Any], emails: List[Dict[str, Any]], 
                               files: List[Dict[str, Any]]) -> Dict[str, str]:
        """Build attendee context from emails and files"""
        attendee_email = attendee.get('email', '').lower()

        # Find emails involving this attendee
        relevant_emails = [
            e for e in emails
            if attendee_email in (e.get('from') or '').lower() or attendee_email in (e.get('to') or '').lower()
        ]
        relevant_emails.sort(key=lambda e: self._parse_date(e.get('date', '')), reverse=True)
        relevant_emails = relevant_emails[:20]

        email_context = '\n\n'.join([
            f"""Email {idx + 1}:
Subject: {e.get('subject', 'No subject')}
From: {e.get('from', 'Unknown')}
To: {e.get('to', 'Unknown')}
Date: {e.get('date', 'Unknown')}
Content: {(e.get('body') or e.get('snippet') or '')[:1000]}
---"""
            for idx, e in enumerate(relevant_emails)
        ]) if relevant_emails else 'No recent email interactions'

        # Find files owned or modified by this attendee
        relevant_files = [
            f for f in files
            if attendee_email in (f.get('owner') or '').lower() or
               (f.get('content') and attendee_email in f.get('content', '').lower())
        ]
        relevant_files.sort(key=lambda f: self._parse_date(f.get('modifiedTime', '')), reverse=True)
        relevant_files = relevant_files[:5]

        document_context = '\n\n'.join([
            f"""Document {idx + 1}:
Name: {f.get('name', 'Unknown')}
Type: {f.get('mimeType', 'Unknown')}
Owner: {f.get('owner', 'Unknown')}
Last Modified: {f.get('modifiedTime', 'Unknown')}
Content:
{(f.get('content') or '')[:15000]}
---"""
            for idx, f in enumerate(relevant_files)
        ]) if relevant_files else 'No recent document activity'

        return {'emailContext': email_context, 'documentContext': document_context}

    def extract_company(self, attendee: Dict[str, Any]) -> str:
        """Extract company from email domain"""
        try:
            email = attendee.get('email', '')
            if '@' not in email:
                return ''
            domain = email.split('@')[1]
            if not domain:
                return ''

            # Remove common TLDs and format
            company = domain.split('.')[0].replace('_', ' ').replace('-', ' ')
            company = ' '.join([word.capitalize() for word in company.split()])
            return company
        except Exception:
            return ''

    def extract_title_from_web_results(self, search_results: List[Dict[str, Any]], name: str) -> str:
        """Extract title from web search results using regex patterns"""
        try:
            # Common title patterns
            title_patterns = [
                re.compile(r'(?:is|as|currently|serves as|works as|role as|position as|title is)\s+(?:a|an|the)?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:\s+of)?)', re.I),
                re.compile(r'([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+at\s+', re.I),
                re.compile(r'(?:^|\s)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,4})\s*\|'),
                re.compile(r'(?:^|\s)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,4})\s*\-'),
                re.compile(f'{re.escape(name)}\\s*[\\|\\-]\\s*([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){{0,4}})', re.I)
            ]

            # Common job title keywords
            title_keywords = [
                'CEO', 'CTO', 'CFO', 'COO', 'CMO', 'CIO', 'CISO',
                'President', 'Vice President', 'VP', 'Director', 'Manager',
                'Engineer', 'Developer', 'Designer', 'Architect', 'Analyst',
                'Lead', 'Senior', 'Principal', 'Head', 'Chief',
                'Founder', 'Co-Founder', 'Partner', 'Consultant',
                'Specialist', 'Coordinator', 'Administrator'
            ]

            # Search through results
            for result in search_results:
                text = (result.get('text') or result.get('content') or '')[:2000]

                # Try each pattern
                for pattern in title_patterns:
                    match = pattern.search(text)
                    if match and match.group(1):
                        potential_title = match.group(1).strip()
                        # Verify it contains a title keyword
                        if any(keyword.lower() in potential_title.lower() for keyword in title_keywords):
                            return potential_title

            return ''
        except Exception as e:
            logger.error(f'Error extracting title from web results: {str(e)}')
            return ''

    def count_interactions(self, attendees: List[Dict[str, Any]], emails: List[Dict[str, Any]], 
                          calendar_events: List[Dict[str, Any]]) -> str:
        """Count interactions per attendee"""
        counts = {}

        for att in attendees:
            email = att.get('email', '').lower()
            count = 0

            for e in emails:
                if email in (e.get('from') or '').lower() or email in (e.get('to') or '').lower():
                    count += 1

            for event in calendar_events:
                event_attendees = event.get('attendees', [])
                if any(a.get('email', '').lower() == email for a in event_attendees):
                    count += 1

            counts[att.get('name') or att.get('email')] = count

        return '\n'.join([
            f"{name}: {count} interactions"
            for name, count in counts.items()
        ])

    def analyze_email_patterns(self, attendees: List[Dict[str, Any]], emails: List[Dict[str, Any]]) -> str:
        """Analyze email patterns"""
        patterns = []

        for att in attendees:
            email = att.get('email', '').lower()
            attendee_emails = [
                e for e in emails
                if email in (e.get('from') or '').lower() or email in (e.get('to') or '').lower()
            ]

            if attendee_emails:
                most_recent = attendee_emails[0]
                patterns.append(
                    f"{att.get('name') or att.get('email')}: Last contact {most_recent.get('date', 'Unknown')} - \"{most_recent.get('subject', 'No subject')}\""
                )

        return '\n'.join(patterns) if patterns else 'No recent email patterns'

    def _parse_date(self, date_str: str) -> str:
        """Parse date string to ISO format for sorting"""
        try:
            from datetime import datetime
            if not date_str:
                return ''
            # Try parsing various date formats
            for fmt in ['%Y-%m-%dT%H:%M:%S', '%Y-%m-%d', '%Y-%m-%d %H:%M:%S']:
                try:
                    dt = datetime.strptime(date_str[:19], fmt)
                    return dt.isoformat()
                except:
                    continue
            # Fallback: try parsing with dateutil
            from dateutil import parser
            return parser.parse(date_str).isoformat()
        except:
            return date_str

    def _get_iso_timestamp(self) -> str:
        """Get current ISO timestamp"""
        from datetime import datetime
        return datetime.utcnow().isoformat()

