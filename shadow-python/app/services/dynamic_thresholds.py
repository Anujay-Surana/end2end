"""
Dynamic Thresholds Service

Provides adaptive filtering thresholds based on data quality distribution
Replaces static "include 60-80%" with intelligent percentile-based selection
"""

from typing import List, Dict, Any, Optional
from app.services.logger import logger


def calculate_optimal_cutoff(scores: List[float], options: Dict[str, Any] = None) -> float:
    """
    Calculate optimal cutoff threshold based on score distribution
    Uses the "elbow method" to find natural breakpoint in scores
    Args:
        scores: Array of relevance scores (0-1)
        options: Threshold options
    Returns:
        Optimal cutoff threshold
    """
    if options is None:
        options = {}
    
    min_percentile = options.get('minPercentile', 50)
    max_percentile = options.get('maxPercentile', 90)
    quality_threshold = options.get('qualityThreshold', 0.7)
    
    if not scores or len(scores) == 0:
        return 0.0
    if len(scores) == 1:
        return scores[0]
    
    # Sort scores descending
    sorted_scores = sorted(scores, reverse=True)
    
    # If top score is below quality threshold, use percentile-based approach
    if sorted_scores[0] < quality_threshold:
        # Low overall quality - be more selective
        percentile_index = int(len(sorted_scores) * (min_percentile / 100))
        return sorted_scores[min(percentile_index, len(sorted_scores) - 1)]
    
    # High quality data - find the "elbow" where scores drop significantly
    max_drop = 0.0
    elbow_index = 0
    
    for i in range(len(sorted_scores) - 1):
        drop = sorted_scores[i] - sorted_scores[i + 1]
        if drop > max_drop:
            max_drop = drop
            elbow_index = i
    
    # If there's a significant drop (>0.15), use that as cutoff
    if max_drop > 0.15:
        return sorted_scores[elbow_index + 1]
    
    # Otherwise, use quality threshold
    # Find first score below quality threshold
    threshold_index = next((i for i, s in enumerate(sorted_scores) if s < quality_threshold), -1)
    if threshold_index > 0:
        return sorted_scores[threshold_index]
    
    # All scores are high quality - include more
    percentile_index = int(len(sorted_scores) * (max_percentile / 100))
    return sorted_scores[min(percentile_index, len(sorted_scores) - 1)]


def filter_by_adaptive_threshold(items: List[Dict[str, Any]], options: Dict[str, Any] = None) -> List[Dict[str, Any]]:
    """
    Filter items by adaptive threshold
    Args:
        items: Array of items with _score property
        options: Filtering options
    Returns:
        Filtered items above threshold
    """
    if options is None:
        options = {}
    
    if not items or len(items) == 0:
        return []
    
    scores = [item.get('_score') or item.get('_temporalScore') or 0.0 for item in items]
    threshold = calculate_optimal_cutoff(scores, options)
    
    logger.info(f"  📊 Adaptive threshold: {threshold:.3f} (from {len(scores)} items, min={min(scores):.3f}, max={max(scores):.3f})")
    
    filtered = [item for item in items if (item.get('_score') or item.get('_temporalScore') or 0.0) >= threshold]
    
    logger.info(f"  ✓ Selected {len(filtered)}/{len(items)} items ({round(len(filtered) / len(items) * 100)}%)")
    
    return filtered


def determine_optimal_document_count(documents: List[Dict[str, Any]], options: Dict[str, Any] = None) -> int:
    """
    Determine optimal document count based on quality
    Args:
        documents: Array of documents with quality scores
        options: Selection options
    Returns:
        Optimal number of documents to include
    """
    if options is None:
        options = {}
    
    min_count = options.get('minCount', 3)
    max_count = options.get('maxCount', 25)
    quality_threshold = options.get('qualityThreshold', 0.6)
    
    if not documents or len(documents) == 0:
        return 0
    
    # Score documents by quality
    scored_docs = [
        {
            **doc,
            '_qualityScore': doc.get('_score') or doc.get('_temporalScore') or 0.5
        }
        for doc in documents
    ]
    
    # Count high-quality documents
    high_quality_count = sum(1 for doc in scored_docs if doc['_qualityScore'] >= quality_threshold)
    
    # Optimal count: balance between quality and quantity
    if high_quality_count >= min_count:
        return min(high_quality_count, max_count)
    else:
        # Include lower quality if needed to reach minimum
        return min(len(documents), min_count)


def calculate_signal_quality(items: List[Dict[str, Any]]) -> float:
    """
    Calculate overall signal quality of item collection
    Args:
        items: Array of items with scores
    Returns:
        Average quality score (0-1)
    """
    if not items or len(items) == 0:
        return 0.0
    
    scores = [item.get('_score') or item.get('_temporalScore') or 0.0 for item in items]
    return sum(scores) / len(scores) if scores else 0.0

