#!/usr/bin/env python3

import argparse
import json
import math
from dataclasses import dataclass
from datetime import datetime
from datetime import timedelta
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.lines import Line2D
from matplotlib.patches import Rectangle


TZ = ZoneInfo("Asia/Shanghai")
BG = "#F6F7F4"
GRID = "#E1E7E3"
TEXT = "#243238"
MUTED = "#6C7B82"
LIGHT_MUTED = "#93A0A5"
IDLE_FILL = "#EEF2EF"
TOOL_LINE = "#B65A2A"
TOOL_FILL = "#E6C7B3"
NORMAL_LINE = "#2B7688"
NORMAL_FILL = "#BED7DF"


@dataclass(frozen=True)
class LayoutSpec:
    page_width_in: float = 8.2
    page_padding_in: float = 0.30
    panel_gap_in: float = 0.13
    title_panel_h_in: float = 0.92
    summary_panel_h_in: float = 1.20
    legend_panel_h_in: float = 0.96
    chart_panel_h_in: float = 2.46
    chart_title_h_in: float = 0.28
    chart_subtitle_h_in: float = 0.22
    chart_xband_h_in: float = 0.34
    chart_inner_pad_top_in: float = 0.05
    chart_inner_pad_bottom_in: float = 0.02
    plot_left_gutter_in: float = 0.58
    plot_right_note_in: float = 0.12
    panel_title_font: float = 12.8
    panel_subtitle_font: float = 8.8
    title_font: float = 22.0
    subtitle_font: float = 10.8
    summary_label_font: float = 9.4
    summary_value_font: float = 17.2
    legend_font: float = 9.2
    axis_font: float = 8.7
    axis_font_light: float = 8.0
    note_font: float = 7.6


@dataclass(frozen=True)
class Box:
    x: float
    y: float
    w: float
    h: float


@dataclass(frozen=True)
class PlotFrame:
    plot_x: float
    plot_w: float
    note_x: float
    note_w: float


@dataclass(frozen=True)
class MetricDef:
    key: str
    label: str
    transform: Callable[[object], float | None]
    subtitle: str


@dataclass(frozen=True)
class SharedTimeAxis:
    bucket_order: list
    segments: list
    bucket_x: np.ndarray
    tick_positions: list
    tick_labels: list
    display_width: float

    def apply(self, ax, show_labels: bool, font_size: float, color: str):
        ax.set_xlim(0, self.display_width)
        ax.set_xticks(self.tick_positions)
        ax.set_xticklabels(self.tick_labels if show_labels else [])
        ax.tick_params(axis="x", colors=color, labelsize=font_size, length=0, labelbottom=show_labels)

    def shade_idle(self, ax):
        for segment in self.segments:
            if segment["kind"] == "idle":
                ax.axvspan(segment["start"], segment["end"], color=IDLE_FILL, alpha=0.72, lw=0, zorder=0)


@dataclass(frozen=True)
class CoordinateMapper:
    bucket_x: np.ndarray

    def offset_points(self, group: bool) -> np.ndarray:
        return self.bucket_x + (-0.11 if group else 0.11)


def parse_rows(path: Path):
    raw = json.loads(path.read_text())
    rows = raw["requests"]
    for row in rows:
        ts = datetime.fromisoformat(row["ts"].replace("Z", "+00:00")).astimezone(TZ)
        row["_bucket_dt"] = ts.replace(minute=(ts.minute // 30) * 30, second=0, microsecond=0)
    return raw, rows


def full_day_buckets(raw, rows):
    if raw.get("date"):
        day_start = datetime.fromisoformat(f"{raw['date']}T00:00:00").replace(tzinfo=TZ)
    else:
        day_start = min(row["_bucket_dt"] for row in rows).replace(hour=0, minute=0, second=0, microsecond=0)
    return [day_start + timedelta(minutes=30 * i) for i in range(48)]


def build_bucket_stats(raw, rows):
    bucket_order = full_day_buckets(raw, rows)
    metrics = [
        MetricDef("latency", "Latency", lambda v: v / 1000.0 if v is not None else None, "avg dot + IQR range, seconds"),
        MetricDef("input", "Input Tokens", lambda v: float(v) if v is not None else None, "avg dot + IQR range, tokens"),
        MetricDef("output", "Output Tokens", lambda v: float(v) if v is not None else None, "avg dot + IQR range, tokens"),
        MetricDef("chRate", "Cache Hit Rate", lambda v: float(v) * 100.0 if v is not None else None, "avg dot + IQR range, percent"),
    ]
    stats = {metric.key: {True: [None] * len(bucket_order), False: [None] * len(bucket_order)} for metric in metrics}
    sample_counts = {True: [0] * len(bucket_order), False: [0] * len(bucket_order)}

    rows_by_bucket = {bucket_dt: [] for bucket_dt in bucket_order}
    for row in rows:
        rows_by_bucket[row["_bucket_dt"]].append(row)

    for idx, bucket_dt in enumerate(bucket_order):
        bucket_rows = rows_by_bucket[bucket_dt]
        for group in (True, False):
            group_rows = [row for row in bucket_rows if bool(row.get("isTool")) == group]
            sample_counts[group][idx] = len(group_rows)
            for metric in metrics:
                values = []
                for row in group_rows:
                    value = metric.transform(row.get(metric.key))
                    if value is None or not isinstance(value, (int, float)) or math.isnan(value):
                        continue
                    values.append(value)
                if not values:
                    continue
                arr = np.array(values, dtype=float)
                stats[metric.key][group][idx] = {
                    "avg": float(arr.mean()),
                    "q1": float(np.quantile(arr, 0.25)),
                    "q3": float(np.quantile(arr, 0.75)),
                    "min": float(arr.min()),
                    "max": float(arr.max()),
                    "count": int(arr.size),
                }
    return metrics, bucket_order, stats, sample_counts


def build_shared_time_axis(bucket_order, sample_counts, compress_idle=False):
    # X-axis behavior is controlled by the compress_idle switch:
    # - False (default): keep a fixed 24-hour axis so empty days still render at full width.
    # - True: compress consecutive idle-hour runs into a smaller number of x-axis slots.
    active_hours = []
    for hour in range(24):
        total = (
            sample_counts[True][hour * 2]
            + sample_counts[True][hour * 2 + 1]
            + sample_counts[False][hour * 2]
            + sample_counts[False][hour * 2 + 1]
        )
        active_hours.append(total > 0)

    segments = []
    bucket_x = [np.nan] * 48
    tick_positions = []
    tick_labels = []

    if not compress_idle:
        for hour in range(24):
            start = float(hour)
            end = start + 1.0
            bucket_x[hour * 2] = start + 0.28
            bucket_x[hour * 2 + 1] = start + 0.72
            segments.append(
                {
                    "kind": "active" if active_hours[hour] else "idle",
                    "start": start,
                    "end": end,
                    "hour": hour,
                    "label": f"{hour:02d}",
                }
            )
            tick_positions.append((start + end) / 2)
            tick_labels.append(f"{hour:02d}")

        return SharedTimeAxis(
            bucket_order=bucket_order,
            segments=segments,
            bucket_x=np.array(bucket_x, dtype=float),
            tick_positions=tick_positions,
            tick_labels=tick_labels,
            display_width=24.0,
        )

    cursor = 0.0
    hour = 0

    while hour < 24:
        if active_hours[hour]:
            start = cursor
            end = cursor + 1.0
            bucket_x[hour * 2] = start + 0.28
            bucket_x[hour * 2 + 1] = start + 0.72
            segments.append({"kind": "active", "start": start, "end": end, "hour": hour})
            tick_positions.append((start + end) / 2)
            tick_labels.append(f"{hour:02d}")
            cursor = end
            hour += 1
            continue

        idle_start = hour
        while hour < 24 and not active_hours[hour]:
            hour += 1
        idle_len = hour - idle_start
        start = cursor
        end = cursor + 1.0
        label = f"{idle_start:02d}" if idle_len == 1 else f"{idle_start:02d}-{max(idle_start, hour - 1):02d}"
        segments.append(
            {
                "kind": "idle",
                "start": start,
                "end": end,
                "start_hour": idle_start,
                "end_hour": hour,
                "label": label,
            }
        )
        tick_positions.append((start + end) / 2)
        tick_labels.append(label)
        cursor = end

    return SharedTimeAxis(
        bucket_order=bucket_order,
        segments=segments,
        bucket_x=np.array(bucket_x, dtype=float),
        tick_positions=tick_positions,
        tick_labels=tick_labels,
        display_width=cursor,
    )


def pretty_tokens(value):
    if value >= 1000000:
        return f"{value / 1000000:.1f}M"
    if value >= 1000:
        return f"{value / 1000:.0f}k"
    return f"{value:.0f}"


def metric_ticks(metric_key, upper):
    if metric_key == "chRate":
        base = [0, 25, 50, 75, 100]
        return base, [f"{v}%" for v in base]
    ticks = list(np.linspace(0, upper, 5))
    if metric_key == "latency":
        labels = [f"{v:.0f}s" if v >= 10 else f"{v:.1f}s" for v in ticks]
    elif metric_key in {"input", "output"}:
        labels = [pretty_tokens(v) for v in ticks]
    else:
        labels = [f"{v:.0f}" for v in ticks]
    return ticks, labels


def axis_strategy(metric_key, stats):
    all_avg = []
    all_q3 = []
    all_max = []
    for group in (True, False):
        for item in stats[metric_key][group]:
            if not item:
                continue
            all_avg.append(item["avg"])
            all_q3.append(item["q3"])
            all_max.append(item["max"])

    if metric_key == "chRate":
        return 100.0, False
    if not all_avg:
        return 1.0, False

    visible_upper = max(
        max(all_avg) * 1.18,
        np.quantile(np.array(all_q3, dtype=float), 0.9) * 1.28 if len(all_q3) > 1 else max(all_q3) * 1.2,
    )
    visible_upper = max(visible_upper, np.quantile(np.array(all_max, dtype=float), 0.75) * 1.05)
    clipped = max(all_max) > visible_upper * 1.03
    return float(visible_upper), clipped


def top_outlier_note(metric_key, stats, bucket_order):
    best = None
    for group in (True, False):
        for idx, item in enumerate(stats[metric_key][group]):
            if not item:
                continue
            score = item["max"]
            if best is None or score > best["value"]:
                best = {"value": score, "group": group, "idx": idx}
    if not best:
        return ""
    bucket_label = bucket_order[best["idx"]].strftime("%H:%M")
    if metric_key == "latency":
        value_label = f"{best['value']:.1f}s"
    elif metric_key == "chRate":
        value_label = f"{best['value']:.0f}%"
    else:
        value_label = pretty_tokens(best["value"])
    group_label = "Tool" if best["group"] else "Normal"
    return f"peak {value_label} · {bucket_label} · {group_label}"


def summary(raw, rows):
    total = len(rows)
    tool = sum(1 for row in rows if row.get("isTool"))
    latency_vals = [row["latency"] for row in rows if isinstance(row.get("latency"), (int, float))]
    cache_vals = [row["chRate"] for row in rows if isinstance(row.get("chRate"), (int, float))]
    return {
        "total": total,
        "tool_share": tool / total if total else 0,
        "avg_latency_s": (sum(latency_vals) / len(latency_vals) / 1000.0) if latency_vals else 0,
        "avg_cache": (sum(cache_vals) / len(cache_vals) * 100.0) if cache_vals else 0,
        "date": raw.get("date", ""),
    }


class Panel:
    def measure(self, layout: LayoutSpec) -> float:
        raise NotImplementedError

    def render(self, fig, page, box: Box):
        raise NotImplementedError


class PageLayout:
    def __init__(self, layout: LayoutSpec, panels: list[Panel]):
        self.layout = layout
        self.panels = panels
        self.panel_heights = [panel.measure(layout) for panel in panels]
        gap_total = layout.panel_gap_in * max(0, len(panels) - 1)
        self.height_in = layout.page_padding_in * 2 + sum(self.panel_heights) + gap_total

    def allocate(self):
        y = self.height_in - self.layout.page_padding_in
        boxes = []
        inner_x = self.layout.page_padding_in
        inner_w = self.layout.page_width_in - self.layout.page_padding_in * 2
        for height in self.panel_heights:
            y -= height
            boxes.append(Box(inner_x, y, inner_w, height))
            y -= self.layout.panel_gap_in
        return boxes

    def add_axes(self, fig, box: Box):
        return fig.add_axes(
            [
                box.x / self.layout.page_width_in,
                box.y / self.height_in,
                box.w / self.layout.page_width_in,
                box.h / self.height_in,
            ]
        )


class TitlePanel(Panel):
    def __init__(self, report):
        self.report = report

    def measure(self, layout: LayoutSpec) -> float:
        return layout.title_panel_h_in

    def render(self, fig, page: PageLayout, box: Box):
        ax = page.add_axes(fig, box)
        ax.axis("off")
        ax.set_facecolor(BG)
        ax.text(0.0, 0.70, "LLM Latency & Token Trends", fontsize=page.layout.title_font, fontweight="bold", color=TEXT)
        ax.text(0.0, 0.28, f"Statistics Date  ·  {self.report['date']}", fontsize=page.layout.subtitle_font, color=MUTED)


class SummaryPanel(Panel):
    def __init__(self, report):
        self.report = report

    def measure(self, layout: LayoutSpec) -> float:
        return layout.summary_panel_h_in

    def render(self, fig, page: PageLayout, box: Box):
        ax = page.add_axes(fig, box)
        ax.axis("off")
        ax.set_facecolor(BG)
        items = [
            ("Total Samples", f"{self.report['total']}"),
            ("Tool Use Share", f"{self.report['tool_share']:.0%}"),
            ("Avg Latency", f"{self.report['avg_latency_s']:.1f}s"),
            ("Avg Cache Hit", f"{self.report['avg_cache']:.0f}%"),
        ]
        cell_h = 0.42
        starts = [(0.00, 0.56), (0.52, 0.56), (0.00, 0.06), (0.52, 0.06)]
        for (label, value), (x0, y0) in zip(items, starts):
            ax.text(x0, y0 + cell_h * 0.70, label, fontsize=page.layout.summary_label_font, color=MUTED, transform=ax.transAxes)
            ax.text(x0, y0 + cell_h * 0.06, value, fontsize=page.layout.summary_value_font, fontweight="bold", color=TEXT, transform=ax.transAxes)


class LegendPanel(Panel):
    def measure(self, layout: LayoutSpec) -> float:
        return layout.legend_panel_h_in

    def render(self, fig, page: PageLayout, box: Box):
        ax = page.add_axes(fig, box)
        ax.axis("off")
        ax.set_facecolor(BG)
        cells = [
            (0.00, 0.56, TOOL_LINE, "dot  Tool Use"),
            (0.52, 0.56, NORMAL_LINE, "dot  Normal Reply"),
            (0.00, 0.10, TOOL_FILL, "band  IQR range (P25-P75)"),
            (0.52, 0.10, "#A4AFB4", "ring  clipped max"),
        ]
        for x0, y0, color, text in cells:
            if text.startswith("band"):
                ax.add_patch(Rectangle((x0, y0 + 0.10), 0.08, 0.08, facecolor=color, edgecolor="none", transform=ax.transAxes, alpha=0.85))
            elif text.startswith("ring"):
                ax.scatter([x0 + 0.04], [y0 + 0.14], s=34, facecolors=BG, edgecolors=color, linewidths=1.0, transform=ax.transAxes)
            else:
                ax.scatter([x0 + 0.04], [y0 + 0.14], s=34, color=color, transform=ax.transAxes)
            ax.text(x0 + 0.11, y0 + 0.09, text.split("  ", 1)[1], fontsize=page.layout.legend_font, color=TEXT, transform=ax.transAxes, va="bottom")


class ChartPanel(Panel):
    def __init__(
        self,
        metric,
        stats,
        sample_counts,
        shared_axis: SharedTimeAxis,
        mapper: CoordinateMapper,
        plot_frame: PlotFrame,
        bucket_order,
        show_x_labels: bool,
        panel_subtitle: str,
        is_count_panel: bool = False,
    ):
        self.metric = metric
        self.stats = stats
        self.sample_counts = sample_counts
        self.shared_axis = shared_axis
        self.mapper = mapper
        self.plot_frame = plot_frame
        self.bucket_order = bucket_order
        self.show_x_labels = show_x_labels
        self.panel_subtitle = panel_subtitle
        self.is_count_panel = is_count_panel

    def measure(self, layout: LayoutSpec) -> float:
        return layout.chart_panel_h_in

    def _axes(self, fig, page: PageLayout, box: Box):
        layout = page.layout
        title_box = Box(box.x, box.y + box.h - layout.chart_title_h_in, box.w, layout.chart_title_h_in)
        subtitle_box = Box(
            box.x,
            box.y + box.h - layout.chart_title_h_in - layout.chart_subtitle_h_in,
            box.w,
            layout.chart_subtitle_h_in,
        )
        plot_h = (
            box.h
            - layout.chart_title_h_in
            - layout.chart_subtitle_h_in
            - layout.chart_xband_h_in
            - layout.chart_inner_pad_top_in
            - layout.chart_inner_pad_bottom_in
        )
        plot_box = Box(
            self.plot_frame.plot_x,
            box.y + layout.chart_xband_h_in + layout.chart_inner_pad_bottom_in,
            self.plot_frame.plot_w,
            plot_h,
        )
        note_box = Box(
            self.plot_frame.note_x,
            box.y + layout.chart_xband_h_in + layout.chart_inner_pad_bottom_in,
            self.plot_frame.note_w,
            box.h - layout.chart_xband_h_in - layout.chart_inner_pad_bottom_in,
        )
        return (
            page.add_axes(fig, title_box),
            page.add_axes(fig, subtitle_box),
            page.add_axes(fig, plot_box),
            page.add_axes(fig, note_box),
        )

    def _setup_plot(self, ax, layout: LayoutSpec):
        ax.set_facecolor(BG)
        for spine in ("top", "right"):
            ax.spines[spine].set_visible(False)
        ax.spines["left"].set_color("#D8DFDB")
        ax.spines["bottom"].set_color("#D8DFDB")
        ax.grid(axis="y", color=GRID, linewidth=0.8)
        ax.grid(axis="x", color="#ECF0ED", linewidth=0.8)
        ax.tick_params(axis="y", colors="#7F8D94", labelsize=layout.axis_font, length=0)
        self.shared_axis.apply(ax, self.show_x_labels, layout.axis_font if self.show_x_labels else layout.axis_font_light, "#7F8D94")
        self.shared_axis.shade_idle(ax)

    def render(self, fig, page: PageLayout, box: Box):
        title_ax, subtitle_ax, plot_ax, note_ax = self._axes(fig, page, box)
        for ax in (title_ax, subtitle_ax, note_ax):
            ax.axis("off")
            ax.set_facecolor(BG)

        title = self.metric.label
        clipped = False
        note_text = ""
        if not self.is_count_panel:
            upper, clipped = axis_strategy(self.metric.key, self.stats)
            title = self.metric.label if not clipped else f"{self.metric.label}  ·  outliers de-emphasized"
            note_text = top_outlier_note(self.metric.key, self.stats, self.bucket_order) if clipped else ""
            self._setup_plot(plot_ax, page.layout)
            plot_ax.set_ylim(0, 100 if self.metric.key == "chRate" else upper)
            ticks, labels = metric_ticks(self.metric.key, plot_ax.get_ylim()[1])
            plot_ax.set_yticks(ticks)
            plot_ax.set_yticklabels(labels)
            self._render_metric_body(plot_ax)
        else:
            self._setup_plot(plot_ax, page.layout)
            self._render_count_body(plot_ax)

        title_ax.text(0.0, 0.14, title, fontsize=page.layout.panel_title_font, fontweight="bold", color=TEXT, va="bottom")
        subtitle_ax.text(0.0, 0.14, self.panel_subtitle, fontsize=page.layout.panel_subtitle_font, color=MUTED, va="bottom")
        if note_text:
            plot_right_ratio = ((self.plot_frame.plot_x + self.plot_frame.plot_w) - box.x) / box.w
            note_x = min(0.995, plot_right_ratio + 0.14)
            title_ax.text(note_x, 0.14, note_text, fontsize=page.layout.note_font, color=MUTED, ha="right", va="bottom")

    def _render_metric_body(self, ax):
        for group, line_color, fill_color in ((True, TOOL_LINE, TOOL_FILL), (False, NORMAL_LINE, NORMAL_FILL)):
            series = self.stats[self.metric.key][group]
            avg = np.array([item["avg"] if item else np.nan for item in series], dtype=float)
            q1 = np.array([item["q1"] if item else np.nan for item in series], dtype=float)
            q3 = np.array([item["q3"] if item else np.nan for item in series], dtype=float)
            max_vals = np.array([item["max"] if item else np.nan for item in series], dtype=float)
            x_offset = self.mapper.offset_points(group)
            mask = ~np.isnan(avg)
            ax.vlines(
                x_offset[mask],
                q1[mask],
                np.minimum(q3[mask], ax.get_ylim()[1]),
                color=fill_color,
                linewidth=6,
                alpha=0.55,
                zorder=1,
            )
            ax.scatter(x_offset[mask], avg[mask], s=22, color=line_color, zorder=2)
            clipped_y = np.minimum(max_vals, ax.get_ylim()[1] * 0.985)
            clip_mask = (~np.isnan(max_vals)) & (max_vals > ax.get_ylim()[1])
            ax.scatter(
                x_offset[clip_mask],
                clipped_y[clip_mask],
                s=16,
                facecolors=BG,
                edgecolors=line_color,
                linewidths=0.9,
                alpha=0.9,
                zorder=3,
            )

    def _render_count_body(self, ax):
        bar_w = 0.18
        valid_x = ~np.isnan(self.shared_axis.bucket_x)
        tool_counts = np.array(self.sample_counts[True], dtype=float)
        normal_counts = np.array(self.sample_counts[False], dtype=float)
        ax.bar(self.shared_axis.bucket_x[valid_x] - bar_w / 2, tool_counts[valid_x], width=bar_w, color=TOOL_FILL, edgecolor="none", zorder=2)
        ax.bar(self.shared_axis.bucket_x[valid_x] + bar_w / 2, normal_counts[valid_x], width=bar_w, color=NORMAL_FILL, edgecolor="none", zorder=2)
        max_count = max(max(self.sample_counts[True]), max(self.sample_counts[False]), 1)
        upper = max_count * 1.22
        ax.set_ylim(0, upper)
        tick_top = math.ceil(max_count / 10) * 10 if max_count >= 10 else max_count
        ticks = sorted(set(int(round(t)) for t in np.linspace(0, tick_top, 4)))
        ax.set_yticks(ticks)
        ax.set_yticklabels([str(t) for t in ticks])


def build_plot_frame(layout: LayoutSpec, page_width_in: float) -> PlotFrame:
    inner_x = layout.page_padding_in
    inner_w = page_width_in - layout.page_padding_in * 2
    plot_x = inner_x + layout.plot_left_gutter_in
    note_w = layout.plot_right_note_in
    plot_w = inner_w - layout.plot_left_gutter_in - note_w
    note_x = plot_x + plot_w
    return PlotFrame(plot_x=plot_x, plot_w=plot_w, note_x=note_x, note_w=note_w)


def render(data_path: Path, output_path: Path, compress_idle: bool = False):
    layout = LayoutSpec()
    raw, rows = parse_rows(data_path)
    metrics, bucket_order, stats, sample_counts = build_bucket_stats(raw, rows)
    report = summary(raw, rows)
    shared_axis = build_shared_time_axis(bucket_order, sample_counts, compress_idle=compress_idle)
    mapper = CoordinateMapper(bucket_x=shared_axis.bucket_x)

    plot_frame = build_plot_frame(layout, layout.page_width_in)

    count_subtitle = (
        "30-minute request count by group  ·  idle-hour runs compressed"
        if compress_idle
        else "30-minute request count by group  ·  full 24-hour axis"
    )

    panels = [
        TitlePanel(report),
        SummaryPanel(report),
        LegendPanel(),
        ChartPanel(metrics[0], stats, sample_counts, shared_axis, mapper, plot_frame, bucket_order, True, metrics[0].subtitle),
        ChartPanel(metrics[1], stats, sample_counts, shared_axis, mapper, plot_frame, bucket_order, True, metrics[1].subtitle),
        ChartPanel(metrics[2], stats, sample_counts, shared_axis, mapper, plot_frame, bucket_order, True, metrics[2].subtitle),
        ChartPanel(metrics[3], stats, sample_counts, shared_axis, mapper, plot_frame, bucket_order, True, metrics[3].subtitle),
        ChartPanel(
            MetricDef("count", "Requests per Bucket", lambda v: None, ""),
            stats,
            sample_counts,
            shared_axis,
            mapper,
            plot_frame,
            bucket_order,
            True,
            count_subtitle,
            is_count_panel=True,
        ),
    ]

    page = PageLayout(layout, panels)

    plt.rcParams.update({"font.family": "DejaVu Sans", "axes.edgecolor": "#D8DFDB", "axes.linewidth": 0.8})
    fig = plt.figure(figsize=(layout.page_width_in, page.height_in), dpi=160, facecolor=BG)
    for panel, box in zip(panels, page.allocate()):
        panel.render(fig, page, box)
    fig.savefig(output_path, facecolor=fig.get_facecolor())


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="projects-ref/snapshot/latency_data_2026-04-22.json")
    parser.add_argument("--output", default="projects-ref/snapshot/latency_data_2026-04-22_chart_panel_refactor.png")
    # Default is full 24-hour rendering. Pass --compress-idle only when the
    # caller explicitly wants consecutive idle-hour runs collapsed on the x-axis.
    parser.add_argument("--compress-idle", action="store_true", help="Compress consecutive idle-hour runs on the x-axis")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    render(Path(args.input), Path(args.output), compress_idle=args.compress_idle)
    print(args.output)
