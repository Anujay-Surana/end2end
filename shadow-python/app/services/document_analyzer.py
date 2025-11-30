"""
Document Analyzer Service

Analyzes documents for meeting relevance, extracts insights, and synthesizes findings
Uses GPT for relevance filtering and content analysis
"""

import asyncio
import json
from datetime import datetime
from typing import List, Dict, Any, Optional, Tuple
from app.services.gpt_service import call_gpt, safe_parse_json
from app.services.temporal_scoring import calculate_recency_score, detect_staleness
from app.services.logger import logger


def _calculate_days_ago(date_str: Optional[str]) -> int:
    """Calculate days ago from date string"""
    if not date_str:
        return 999999
    try:
        date = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
        now = datetime.utcnow()
        days = (now - date.replace(tzinfo=None)).days
        return max(0, days)
    except Exception:
        return 999999


async def _filter_file_batch(
    batch: Dict[str, Any],
    batch_index: int,
    total_batches: int,
    meeting_title: str,
    meeting_date_context: str,
    meeting_context: Optional[Dict[str, Any]],
    user_context: Optional[Dict[str, Any]],
    attendees: List[Dict[str, Any]],
    request_id: str
) -> Dict[str, Any]:
    """Filter a batch of files for relevance"""
    logger.info(
        f'     File relevance check batch {batch_index + 1}/{total_batches} ({len(batch["files"])} files)...',
        requestId=request_id
    )

    user_context_prefix = ''
    if user_context:
        user_context_prefix = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). '

    meeting_context_section = ''
    if meeting_context:
        key_entities = meeting_context.get('keyEntities', [])
        key_topics = meeting_context.get('keyTopics', [])
        meeting_context_section = f'''
MEETING CONTEXT:
- Understood Purpose: {meeting_context.get("understoodPurpose", "")}
- Key Entities: {", ".join(key_entities) if key_entities else "none identified"}
- Key Topics: {", ".join(key_topics) if key_topics else "none identified"}
- Is Specific Meeting: {"yes" if meeting_context.get("isSpecificMeeting") else "no"}
- Confidence: {meeting_context.get("confidence", "unknown")}
- Reasoning: {meeting_context.get("reasoning", "")}'''

    confidence = meeting_context.get('confidence', 'low') if meeting_context else 'low'
    key_entities_str = ', '.join(meeting_context.get('keyEntities', [])) if meeting_context else 'none'

    if confidence == 'low':
        filtering_strictness = f'''
FILTERING STRICTNESS (LOW CONFIDENCE - BE VERY SELECTIVE):
- Only include files with STRONG evidence of relevance to extracted entities/topics
- Require clear, specific connection to meeting entities ({key_entities_str})
- Don't default to general context
- Err on the side of EXCLUSION when uncertain
- Target: 20-40% inclusion rate (be conservative)'''
    elif confidence == 'medium':
        filtering_strictness = '''
FILTERING STRICTNESS (MEDIUM CONFIDENCE):
- Include files with clear connection to meeting
- Prioritize files related to extracted entities/topics
- Target: 40-60% inclusion rate'''
    else:
        filtering_strictness = '''
FILTERING STRICTNESS (HIGH CONFIDENCE):
- Include files that relate to understood purpose/entities
- Can be more comprehensive
- Target: 50-70% inclusion rate'''

    # Build file list for GPT
    attendee_emails = [
        (a.get('email') or a.get('emailAddress') or '').lower()
        for a in attendees
        if a.get('email') or a.get('emailAddress')
    ]

    file_list = []
    for i, f in enumerate(batch['files']):
        modified_date = 'unknown'
        days_ago = 'unknown'
        if f.get('modifiedTime'):
            try:
                date_obj = datetime.fromisoformat(f['modifiedTime'].replace('Z', '+00:00'))
                modified_date = date_obj.strftime('%Y-%m-%d')
                days_ago = _calculate_days_ago(f['modifiedTime'])
            except Exception:
                pass

        owner_email = (f.get('ownerEmail') or f.get('owner') or 'unknown').lower()
        owner_is_attendee = any(att_email in owner_email for att_email in attendee_emails)

        file_list.append(
            f'[{i}] Name: {f.get("name", "")}\n'
            f'Owner: {f.get("ownerEmail") or f.get("owner") or "unknown"}{" (MEETING ATTENDEE)" if owner_is_attendee else ""}\n'
            f'Modified: {modified_date} ({days_ago} days ago)\n'
            f'Type: {f.get("mimeType", "unknown")}'
        )

    user_context_note = ''
    if user_context:
        user_context_note = f"IMPORTANT: {user_context['formattedName']} is the user you are preparing this brief for. Filter files that are relevant to {user_context['formattedName']}'s understanding of this meeting.\n\n"
    
    file_relevance_check = await call_gpt([{
        'role': 'system',
        'content': f'{user_context_prefix}You are filtering files for meeting prep. Meeting: "{meeting_title}"{meeting_date_context}{meeting_context_section}\n\n'
        f'{user_context_note}'
        f'✅ INCLUDE IF:\n'
        f'1. File name/content type suggests relevance to understood meeting purpose\n'
        f'2. File relates to meeting-specific entities/topics\n'
        f'3. File owner is a meeting attendee AND file relates to meeting context\n'
        f'4. File provides context about the understood meeting purpose\n'
        f'5. File involves extracted key entities ({key_entities_str})\n\n'
        f'❌ EXCLUDE IF:\n'
        f'1. File is about different entities/topics than meeting\n'
        f'2. File is general/unrelated to understood purpose\n'
        f'3. File doesn\'t relate to meeting attendees or extracted entities\n'
        f'4. File is clearly unrelated to meeting context\n\n'
        f'DATE CONSIDERATION: Consider file modification date, but don\'t exclude solely based on age - older files can be highly relevant.\n\n'
        f'ATTENDEE PRIORITIZATION: Prioritize files where the owner is a meeting attendee.\n\n'
        f'{filtering_strictness}\n\n'
        f'Return JSON with file indices to INCLUDE (relative to this batch) AND reasoning:\n'
        f'{{"relevant_indices": [0, 3, 7, ...], "reasoning": {{"0": "why file 0 is relevant", "3": "why file 3 is relevant", ...}}}}'
    }, {
        'role': 'user',
        'content': f'Files to filter (metadata only):\n\n' + '\n\n'.join(file_list)
    }], 4000)

    batch_indices = []
    batch_reasoning = {}

    try:
        parsed = safe_parse_json(file_relevance_check)
        batch_indices = [batch['start'] + idx for idx in (parsed.get('relevant_indices') or [])]

        if parsed.get('reasoning'):
            for relative_idx_str, reasoning in parsed['reasoning'].items():
                try:
                    relative_idx = int(relative_idx_str)
                    absolute_idx = batch['start'] + relative_idx
                    batch_reasoning[absolute_idx] = reasoning
                except (ValueError, KeyError):
                    continue
    except Exception as e:
        logger.error(
            f'Failed to parse file relevance check - excluding batch from analysis',
            requestId=request_id,
            error=str(e),
            batchStart=batch['start'],
            batchSize=len(batch['files']),
            meetingTitle=meeting_title
        )
        logger.info(f'  ⚠️  Failed to parse relevance check for batch {batch_index + 1}, excluding from analysis', requestId=request_id)
        batch_indices = []


    return {'indices': batch_indices, 'reasoning': batch_reasoning}


async def _analyze_document_batch(
    batch: Dict[str, Any],
    batch_index: int,
    total_batches: int,
    meeting_title: str,
    meeting_date_context: str,
    request_id: str
) -> List[Dict[str, Any]]:
    """Analyze a batch of documents for insights"""
    logger.info(
        f'     Document analysis batch {batch_index + 1}/{total_batches} ({len(batch["files"])} files)...',
        requestId=request_id
    )

    batch_insights = await asyncio.gather(*[
        _analyze_single_document(file, meeting_title, meeting_date_context, request_id)
        for file in batch['files']
    ])

    logger.info(
        f'     ✓ Batch {batch_index + 1} complete: {sum(1 for b in batch_insights if b["insights"])}/{len(batch_insights)} docs with insights',
        requestId=request_id
    )

    return batch_insights


async def _analyze_single_document(
    file: Dict[str, Any],
    meeting_title: str,
    meeting_date_context: str,
    request_id: str
) -> Dict[str, Any]:
    """Analyze a single document for insights"""
    try:
        modified_date_str = 'unknown'
        if file.get('modifiedTime'):
            try:
                date_obj = datetime.fromisoformat(file['modifiedTime'].replace('Z', '+00:00'))
                modified_date_str = date_obj.strftime('%Y-%m-%d')
            except Exception:
                pass

        insight = await call_gpt([{
            'role': 'system',
            'content': f'Analyze this document for meeting "{meeting_title}"{meeting_date_context}. Extract 3-10 KEY INSIGHTS.\n\n'
            f'Document Type: {file.get("mimeType", "unknown")}\n'
            f'Document Modified: {modified_date_str}\n\n'
            f'Return JSON array of insights: ["insight 1", "insight 2", ...]\n\n'
            f'Each insight should:\n'
            f'- Be specific (include numbers, dates, names, decisions)\n'
            f'- Be 20-80 words\n'
            f'- Quote or reference specific content\n'
            f'- Explain relevance to the meeting\n\n'
            f'Focus on: decisions, data, action items, proposals, problems, solutions, timelines, strategic context.'
        }, {
            'role': 'user',
            'content': f'Document: "{file.get("name", "")}"\n\nContent:\n{file.get("content", "")[:7500]}{"...[Document truncated - showing first 7.5k chars]" if len(file.get("content", "")) > 7500 else ""}'
        }], 4000)

        parsed = safe_parse_json(insight)
        return {
            'fileName': file.get('name', ''),
            'insights': parsed if isinstance(parsed, list) else []
        }
    except Exception as e:
        logger.error(f'  ⚠️  Error analyzing {file.get("name", "")}: {str(e)}', requestId=request_id)
        return {'fileName': file.get('name', ''), 'insights': []}


async def analyze_documents(
    files: List[Dict[str, Any]],
    meeting_title: str,
    meeting_date_context: str,
    meeting_context: Optional[Dict[str, Any]],
    user_context: Optional[Dict[str, Any]],
    attendees: List[Dict[str, Any]],
    request_id: str = 'unknown'
) -> Tuple[str, List[Dict[str, Any]], Dict[str, Any]]:
    """
    Analyze documents for meeting relevance and extract insights
    
    Args:
        files: List of file objects
        meeting_title: Meeting title
        meeting_date_context: Formatted meeting date context string
        meeting_context: Meeting context understanding (optional)
        user_context: User context object (optional)
        attendees: List of attendee objects
        request_id: Request ID for logging
    
    Returns:
        Tuple of (document_analysis, files_with_content, extraction_data)
        extraction_data contains: fileRelevanceReasoning, documentStaleness, relevantContent
    """
    logger.info(f'\n  📄 Analyzing document content for meeting relevance...', requestId=request_id)

    document_analysis = ''
    files_with_content = []
    extraction_data = {
        'fileRelevanceReasoning': {},
        'documentStaleness': {},
        'relevantContent': {'documents': []}
    }

    if not files:
        document_analysis = 'No relevant documents found.'
        return document_analysis, files_with_content, extraction_data

    # Filter and prioritize documents
    # 1. Filter out image files, prioritize text-based documents
    text_based_files = [
        f for f in files
        if f.get('content') and len(f.get('content', '')) >= 100
    ]

    mime_type_filtered = []
    for f in text_based_files:
        mime_type = (f.get('mimeType') or '').lower()
        # Skip images
        if mime_type.startswith('image/'):
            continue
        # Prioritize: Google Docs, Sheets, PDFs, Word docs, text files
        if any(keyword in mime_type for keyword in ['document', 'spreadsheet', 'pdf', 'text', 'word']):
            mime_type_filtered.append(f)

    # 2. Sort by modification date (recent first)
    mime_type_filtered.sort(
        key=lambda f: datetime.fromisoformat(f['modifiedTime'].replace('Z', '+00:00')).timestamp() if f.get('modifiedTime') else 0,
        reverse=True
    )

    # 3. Prioritize documents shared with more attendees
    attendee_emails = [
        (a.get('email') or a.get('emailAddress') or '').lower()
        for a in attendees
        if a.get('email') or a.get('emailAddress')
    ]

    def prioritize_by_attendee(f):
        owner_email = (f.get('ownerEmail') or '').lower()
        return any(att_email in owner_email for att_email in attendee_emails)

    mime_type_filtered.sort(key=prioritize_by_attendee, reverse=True)

    files_with_content = mime_type_filtered

    # ===== FILE RELEVANCE FILTERING (METADATA-ONLY) =====
    original_file_count = len(files_with_content)
    if files_with_content and meeting_context:
        logger.info(f'  🔍 Filtering {len(files_with_content)} files for meeting relevance...', requestId=request_id)

        file_batch_size = 50
        file_batches = []
        for batch_start in range(0, len(files_with_content), file_batch_size):
            file_batches.append({
                'start': batch_start,
                'end': min(batch_start + file_batch_size, len(files_with_content)),
                'files': files_with_content[batch_start:min(batch_start + file_batch_size, len(files_with_content))]
            })

        logger.info(f'  🚀 Processing {len(file_batches)} file batches...', requestId=request_id)

        file_relevance_promises = [
            _filter_file_batch(
                batch, i, len(file_batches), meeting_title, meeting_date_context,
                meeting_context, user_context, attendees, request_id
            )
            for i, batch in enumerate(file_batches)
        ]

        file_relevance_results = await asyncio.gather(*file_relevance_promises)
        all_file_relevant_indices = []
        all_file_relevance_reasoning = {}

        for result in file_relevance_results:
            all_file_relevant_indices.extend(result['indices'])
            all_file_relevance_reasoning.update(result['reasoning'])

        extraction_data['fileRelevanceReasoning'] = all_file_relevance_reasoning

        logger.info(f'  ✓ Total relevant files: {len(all_file_relevant_indices)}/{original_file_count}', requestId=request_id)

        # Limit to top 15-20 most relevant files
        max_files_to_analyze = 20
        if all_file_relevant_indices:
            relevant_files = [
                {'idx': idx, 'file': files_with_content[idx]}
                for idx in all_file_relevant_indices
                if idx < len(files_with_content)
            ]
            relevant_files = [item for item in relevant_files if item['file']]

            # Sort by recency first
            relevant_files.sort(
                key=lambda item: datetime.fromisoformat(item.get('file', {}).get('modifiedTime', '').replace('Z', '+00:00')).timestamp() if (isinstance(item, dict) and isinstance(item.get('file'), dict) and item.get('file', {}).get('modifiedTime')) else 0,
                reverse=True
            )

            relevant_files = relevant_files[:max_files_to_analyze]
            files_with_content = [item['file'] for item in relevant_files]
            logger.info(f'  ✓ Limiting deep analysis to top {len(files_with_content)} most relevant files', requestId=request_id)
        else:
            files_with_content = []
            logger.info(f'  ⚠️  No relevant files found after filtering', requestId=request_id)
    elif files_with_content and not meeting_context:
        logger.info(f'  ⚠️  Skipping file relevance filtering (no meeting context available), analyzing all {len(files_with_content)} files', requestId=request_id)

    if files_with_content:
        logger.info(f'  📊 Deep analysis of {len(files_with_content)} relevant documents...', requestId=request_id)

        # Create batches for progress logging
        doc_batch_size = 5
        doc_batches = []
        for i in range(0, len(files_with_content), doc_batch_size):
            doc_batches.append({
                'index': i // doc_batch_size,
                'files': files_with_content[i:i + doc_batch_size]
            })

        # Process all batches in parallel
        doc_batch_promises = [
            _analyze_document_batch(batch, batch['index'], len(doc_batches), meeting_title, meeting_date_context, request_id)
            for batch in doc_batches
        ]

        # Execute all document analysis in parallel
        all_doc_insights = []
        for batch_result in await asyncio.gather(*doc_batch_promises):
            all_doc_insights.extend(batch_result)

        logger.info(f'  ✓ Analyzed {len(all_doc_insights)} documents in PARALLEL', requestId=request_id)

        all_insights = [d for d in all_doc_insights if d.get('insights')]

        # Detect staleness in documents and store relevance data
        staleness_results = []
        for file in files_with_content:
            staleness_result = detect_staleness(file.get('content') or file.get('name', ''))
            staleness_results.append({
                'fileName': file.get('name', ''),
                'modifiedDate': file.get('modifiedTime'),
                'staleness': staleness_result,
                'recencyScore': calculate_recency_score(file.get('modifiedTime'), 0.01)
            })

        # Store relevant documents for UI
        extraction_data['relevantContent']['documents'] = [
            {
                'name': file.get('name', ''),
                'modifiedTime': file.get('modifiedTime'),
                'mimeType': file.get('mimeType'),
                'owner': file.get('owner'),
                'relevanceReasoning': f'Document "{file.get("name", "")}" is relevant to meeting "{meeting_title}" based on content analysis',
                'recencyScore': calculate_recency_score(file.get('modifiedTime'), 0.01),
                'staleness': detect_staleness(file.get('content') or file.get('name', ''))
            }
            for file in files_with_content
        ]

        stale_documents = [r for r in staleness_results if isinstance(r, dict) and isinstance(r.get('staleness'), dict) and r.get('staleness', {}).get('isStale')]
        if stale_documents:
            logger.info(f'  ⚠️  Detected {len(stale_documents)} potentially stale documents', requestId=request_id)
            for doc in stale_documents[:5]:
                if not isinstance(doc, dict):
                    continue
                staleness_obj = doc.get('staleness')
                if not isinstance(staleness_obj, dict):
                    continue
                indicators = staleness_obj.get('indicators', [])
                indicator_values = [i.get('value', '') for i in indicators if isinstance(i, dict)]
                logger.info(f'     - {doc.get("fileName", "Unknown")}: {", ".join(indicator_values)}', requestId=request_id)

        # Store document staleness info for UI
        for r in staleness_results:
            extraction_data['documentStaleness'][r['fileName']] = r['staleness']

        if all_insights:
            user_context_prefix = ''
            if user_context:
                user_context_prefix = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). '

            # Include staleness warnings in prompt
            staleness_warning = ''
            if stale_documents:
                warning_lines = [
                    f'- "{d.get("fileName", "Unknown")}": {", ".join([i.get("value", "") for i in d.get("staleness", {}).get("indicators", []) if isinstance(i, dict)]) if isinstance(d.get("staleness"), dict) else ""}'
                    for d in stale_documents
                    if isinstance(d, dict)
                ]
                staleness_warning = f'\n\nWARNING - POTENTIALLY OUTDATED CONTENT: {len(stale_documents)} documents contain temporal references that may be outdated:\n' + '\n'.join(warning_lines) + '\n\nWhen synthesizing, FLAG any information that may be outdated and note the document\'s last modified date.'

            perspective_owner = "the user's" if not user_context else f"{user_context['formattedName']}'s"
            doc_narrative = await call_gpt([{
                'role': 'system',
                'content': f'{user_context_prefix}You are creating a comprehensive document analysis for meeting prep. Synthesize these document insights into a detailed paragraph (6-12 sentences) from {perspective_owner} perspective.{staleness_warning}\n\n'
                f'Document Insights:\n'
                f'{json.dumps(all_insights, indent=2)}\n\n'
                f'Guidelines:\n'
                f'- Organize by importance and relevance to meeting "{meeting_title}"\n'
                f'- Prioritize most recent and most relevant information first\n'
                f'- Reference specific documents by name\n'
                f'- Include concrete details: numbers, dates, decisions, proposals\n'
                f'- Connect insights across documents if relevant\n'
                f'- Focus on actionable information for the meeting\n'
                f'- Remove duplicate insights across documents'
            }, {
                'role': 'user',
                'content': f'Create comprehensive document analysis for meeting: {meeting_title}'
            }], 4000)

            document_analysis = doc_narrative.strip() if doc_narrative else 'Document analysis in progress.'
            logger.info(f'  ✓ Document analysis: {len(document_analysis)} chars from {len(all_insights)} docs', requestId=request_id)
        else:
            document_analysis = f'Analyzed {len(files_with_content)} documents but found limited content directly relevant to "{meeting_title}".'
    elif files:
        more_files_str = f" and {len(files) - 5} more" if len(files) > 5 else ""
        document_analysis = f'Found {len(files)} potentially relevant documents: {", ".join([f.get("name", "") for f in files[:5]])}{more_files_str}. Unable to access full content.'
    else:
        document_analysis = 'No relevant documents found.'

    return document_analysis, files_with_content, extraction_data

