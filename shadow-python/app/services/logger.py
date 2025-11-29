"""
Structured Logging Service

Uses structlog for fast, structured logging
"""

import os
import structlog
import logging

# Configure structlog
structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
        structlog.processors.JSONRenderer() if os.getenv('NODE_ENV') == 'production' else structlog.dev.ConsoleRenderer()
    ],
    context_class=dict,
    logger_factory=structlog.stdlib.LoggerFactory(),
    wrapper_class=structlog.stdlib.BoundLogger,
    cache_logger_on_first_use=True,
)

# Get log level from environment
log_level = os.getenv('LOG_LEVEL', 'info' if os.getenv('NODE_ENV') == 'production' else 'info')
logging.basicConfig(
    format="%(message)s",
    stream=os.sys.stdout,
    level=getattr(logging, log_level.upper()),
)

# Suppress verbose HTTP client logging (httpx, httpcore)
logging.getLogger('httpx').setLevel(logging.WARNING)
logging.getLogger('httpcore').setLevel(logging.WARNING)
logging.getLogger('httpcore.http11').setLevel(logging.WARNING)
logging.getLogger('httpcore.http2').setLevel(logging.WARNING)
logging.getLogger('httpcore.connection').setLevel(logging.WARNING)

# Create logger instance
logger = structlog.get_logger()

"""
Log levels:
- trace: Very detailed debugging (use debug in Python)
- debug: Debugging information
- info: General information
- warn: Warning messages
- error: Error messages
- fatal: Fatal errors (use critical in Python)
"""

