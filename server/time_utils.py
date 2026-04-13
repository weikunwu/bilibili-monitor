"""Shared time helpers (kept out of routes/ to avoid circular imports)."""

from datetime import datetime, timezone, timedelta


def beijing_time_range(period: str) -> tuple[str, str, str]:
    """Return (utc_start, utc_end, display_label) for a given period in Beijing time."""
    beijing_tz = timezone(timedelta(hours=8))
    now_bj = datetime.now(beijing_tz)
    if period == "yesterday":
        day = now_bj - timedelta(days=1)
        start = day.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
        label = start.strftime("%Y-%m-%d")
    elif period == "this_month":
        start = now_bj.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        end = now_bj.replace(hour=23, minute=59, second=59, microsecond=0) + timedelta(seconds=1)
        label = start.strftime("%Y-%m")
    elif period == "last_month":
        first_this = now_bj.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        last_month_end = first_this
        last_month_start = (first_this - timedelta(days=1)).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        start = last_month_start
        end = last_month_end
        label = start.strftime("%Y-%m")
    else:  # today
        start = now_bj.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
        label = start.strftime("%Y-%m-%d")
    utc_start = start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    utc_end = end.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return utc_start, utc_end, label
