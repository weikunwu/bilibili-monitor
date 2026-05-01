"""Shared time helpers (kept out of routes/ to avoid circular imports)."""

from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import HTTPException


MAX_QUERY_RANGE_DAYS = 31


def _parse_utc(s: str) -> Optional[datetime]:
    """Parse 'YYYY-MM-DD HH:MM:SS' (naive, treated as UTC) or ISO 'YYYY-MM-DDTHH:MM:SS(.ffff)(Z|+HH:MM)'.
    返回 None 表示解析失败——调用方应该容忍，不要因为前端偶发格式报 500。"""
    if not s:
        return None
    try:
        if "T" in s:
            s2 = s.rstrip("Z")
            dt = datetime.fromisoformat(s2)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)
        return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def enforce_query_range(time_from: Optional[str], time_to: Optional[str]) -> None:
    """Raise HTTPException(400) 如果 [from, to] 跨度超过 MAX_QUERY_RANGE_DAYS。
    只给一头或都不给时不做限制，调用端自己按 limit 裁结果。"""
    a = _parse_utc(time_from) if time_from else None
    b = _parse_utc(time_to) if time_to else None
    if a and b and (b - a) > timedelta(days=MAX_QUERY_RANGE_DAYS):
        raise HTTPException(400, f"时间区间最多 {MAX_QUERY_RANGE_DAYS} 天")


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
    elif period == "this_year":
        start = now_bj.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
        end = now_bj.replace(hour=23, minute=59, second=59, microsecond=0) + timedelta(seconds=1)
        label = start.strftime("%Y")
    elif period == "last_year":
        start = now_bj.replace(year=now_bj.year - 1, month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
        end = start.replace(year=now_bj.year)
        label = start.strftime("%Y")
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
