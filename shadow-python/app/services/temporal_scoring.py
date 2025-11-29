"""
Temporal Scoring Service

Provides intelligent time-based relevance scoring for emails, documents, and events
Implements decay functions, staleness detection, and trend analysis
"""

import re
from datetime import datetime
from typing import Dict, List, Any, Optional


def calculate_recency_score(date: Optional[str], lambda_decay: float = 0.01) -> float:
    """
    Calculate recency score using exponential decay
    Args:
        date: The date of the content (ISO string or datetime)
        lambda_decay: Decay rate (default: 0.01 for slow decay)
    Returns:
        Score between 0 and 1 (1 = today, approaches 0 as time passes)
    """
    if not date:
        return 0.5  # Unknown date gets middle score
    
    try:
        if isinstance(date, str):
            content_date = datetime.fromisoformat(date.replace('Z', '+00:00'))
        else:
            content_date = date
        
        now = datetime.utcnow()
        days_old = max(0, (now - content_date.replace(tzinfo=None)).days)
        
        # Exponential decay: score = e^(-λ * days)
        score = pow(2.71828, -lambda_decay * days_old)
        
        return max(0.0, min(1.0, score))
    except Exception:
        return 0.5


def calculate_weighted_score(base_relevance: float, date: Optional[str], options: Dict[str, Any] = None) -> float:
    """
    Calculate relevance score with recency weighting
    Args:
        base_relevance: Base relevance score (0-1)
        date: Content date
        options: Scoring options
    Returns:
        Final weighted score (0-1)
    """
    if options is None:
        options = {}
    
    recency_weight = options.get('recencyWeight', 0.3)
    lambda_decay = options.get('lambda', 0.015)
    
    recency_score = calculate_recency_score(date, lambda_decay)
    
    # Weighted combination: 70% relevance, 30% recency (by default)
    final_score = (base_relevance * (1 - recency_weight)) + (recency_score * recency_weight)
    
    return final_score


def detect_staleness(text: str) -> Dict[str, Any]:
    """
    Detect if content contains outdated temporal references
    Args:
        text: Content text to analyze
    Returns:
        Staleness detection result
    """
    if not text:
        return {'isStale': False, 'indicators': []}
    
    now = datetime.utcnow()
    current_year = now.year
    current_quarter = (now.month - 1) // 3 + 1
    current_month = now.month
    
    indicators = []
    
    # Check for old year references (2+ years old)
    year_matches = re.findall(r'\b(20\d{2})\b', text)
    old_years = [y for y in year_matches if int(y) < current_year - 1]
    if old_years:
        indicators.append({
            'type': 'old_year',
            'value': ', '.join(set(old_years)),
            'severity': 'medium'
        })
    
    # Check for old quarter references
    quarter_matches = re.findall(r'Q[1-4]\s*(20\d{2})?', text, re.I)
    for match in quarter_matches:
        year_match = re.search(r'20\d{2}', match)
        quarter_match = re.search(r'Q([1-4])', match, re.I)
        if quarter_match:
            quarter = int(quarter_match.group(1))
            reference_year = int(year_match.group(0)) if year_match else current_year
            
            if reference_year < current_year or (reference_year == current_year and quarter < current_quarter - 1):
                indicators.append({
                    'type': 'old_quarter',
                    'value': match,
                    'severity': 'high'
                })
    
    # Check for "last week/month" but content is months old
    relative_time_matches = re.findall(r'\b(last|this|next)\s+(week|month|quarter)\b', text, re.I)
    if relative_time_matches:
        indicators.append({
            'type': 'relative_time',
            'value': ', '.join([' '.join(m) for m in relative_time_matches]),
            'severity': 'low'
        })
    
    return {
        'isStale': len(indicators) > 0,
        'indicators': indicators
    }


def analyze_trend(items: List[Dict[str, Any]], date_field: str = 'date') -> Dict[str, Any]:
    """
    Analyze temporal trend in items
    Args:
        items: Array of items with dates
        date_field: Field name containing date
    Returns:
        Trend analysis
    """
    if not items or len(items) < 2:
        return {'trend': 'insufficient_data', 'velocity': 0}
    
    # Sort by date
    sorted_items = sorted(
        [item for item in items if item.get(date_field)],
        key=lambda x: x.get(date_field, ''),
        reverse=True
    )
    
    if len(sorted_items) < 2:
        return {'trend': 'insufficient_data', 'velocity': 0}
    
    # Calculate velocity (items per day)
    try:
        first_date = datetime.fromisoformat(sorted_items[0].get(date_field).replace('Z', '+00:00'))
        last_date = datetime.fromisoformat(sorted_items[-1].get(date_field).replace('Z', '+00:00'))
        days_span = max(1, (first_date - last_date).days)
        velocity = len(sorted_items) / days_span
        
        # Determine trend
        if velocity > 0.5:
            trend = 'increasing'
        elif velocity > 0.1:
            trend = 'stable'
        else:
            trend = 'decreasing'
        
        return {
            'trend': trend,
            'velocity': velocity,
            'itemCount': len(sorted_items),
            'daysSpan': days_span
        }
    except Exception:
        return {'trend': 'unknown', 'velocity': 0}


def score_and_rank_emails(emails: List[Dict[str, Any]], meeting_date: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Score and rank emails by temporal relevance
    Args:
        emails: Array of email objects
        meeting_date: Meeting date for context
    Returns:
        Scored and ranked emails
    """
    if not emails:
        return []
    
    # Score each email
    scored_emails = []
    for email in emails:
        email_date = email.get('date')
        recency_score = calculate_recency_score(email_date)
        
        # Base relevance (can be enhanced with content analysis)
        base_relevance = 0.7  # Default moderate relevance
        
        # Weighted score
        final_score = calculate_weighted_score(base_relevance, email_date)
        
        scored_emails.append({
            **email,
            '_temporalScore': final_score,
            '_recencyScore': recency_score
        })
    
    # Sort by score (highest first)
    scored_emails.sort(key=lambda x: x.get('_temporalScore', 0), reverse=True)
    
    return scored_emails

