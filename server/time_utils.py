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
    elif period == "this_week":
        # Week starts Monday (ISO). Monday.weekday() == 0.
        monday = now_bj - timedelta(days=now_bj.weekday())
        start = monday.replace(hour=0, minute=0, second=0, microsecond=0)
        end = now_bj.replace(hour=23, minute=59, second=59, microsecond=0) + timedelta(seconds=1)
        label = start.strftime("%Y-%m")
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
    elif period.startswith("month:"):
        # "month:N" → Nth month of the current year. For the current month
        # end = now (partial data); for past months end = first-of-next-month.
        try:
            m = int(period.split(":", 1)[1])
        except (ValueError, IndexError):
            m = now_bj.month
        m = max(1, min(12, m))
        # Future month → fall back to the same month last year, so e.g.
        # "12月盲盒" typed in June 2026 queries Dec 2025.
        year = now_bj.year if m <= now_bj.month else now_bj.year - 1
        start = now_bj.replace(year=year, month=m, day=1, hour=0, minute=0, second=0, microsecond=0)
        if year == now_bj.year and m == now_bj.month:
            end = now_bj.replace(hour=23, minute=59, second=59, microsecond=0) + timedelta(seconds=1)
        elif m == 12:
            end = start.replace(year=year + 1, month=1)
        else:
            end = start.replace(month=m + 1)
        label = start.strftime("%Y-%m")
        utc_start = start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        utc_end = end.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        return utc_start, utc_end, label
    else:  # today
        start = now_bj.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
        label = start.strftime("%Y-%m-%d")
    utc_start = start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    utc_end = end.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return utc_start, utc_end, label
