from __future__ import annotations

import csv
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


ROOT = Path(__file__).resolve().parent
RESULTS = Path("/home/meet/code/projects/git/flight-tracker/data/raw_adsbx/filtered/mumbai_insights/results")
CHARTS = ROOT / "charts"

BG = "#0b1020"
PANEL = "#111827"
GRID = "#334155"
TEXT = "#e2e8f0"
TEXT_MUTED = "#94a3b8"
BLUE = "#38bdf8"
ORANGE = "#f59e0b"
TEAL = "#14b8a6"


def read_csv(name: str):
    with (RESULTS / name).open(newline="") as fh:
        return list(csv.DictReader(fh))


def setup_figure(width=12, height=7):
    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.titlesize": 18,
            "axes.labelsize": 12,
            "xtick.labelsize": 10,
            "ytick.labelsize": 10,
        }
    )
    fig, ax = plt.subplots(figsize=(width, height), dpi=180)
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(PANEL)
    return fig, ax


def save(fig, stem: str):
    CHARTS.mkdir(parents=True, exist_ok=True)
    fig.savefig(CHARTS / f"{stem}.png", bbox_inches="tight")
    fig.savefig(CHARTS / f"{stem}.svg", bbox_inches="tight")
    plt.close(fig)


def render_hourly_avg():
    rows = read_csv("hourly_avg.csv")
    hours = [r["hour_ist"] for r in rows]
    values = [float(r["avg_movements_per_sampled_day"]) for r in rows]

    fig, ax = setup_figure(13, 7.6)
    bars = ax.bar(hours, values, color=BLUE, width=0.72, edgecolor="#1e293b")
    ax.set_title("Average Movements by Hour (IST)", loc="left", pad=18, fontweight="bold")
    ax.text(
        0.0,
        1.015,
        "Typical sampled-day hourly pattern, averaged across the archive",
        transform=ax.transAxes,
        fontsize=11,
        color=TEXT_MUTED,
    )
    ax.set_ylabel("Average movements per sampled day", labelpad=16)
    ax.set_xlabel("Hour of day (IST)")
    ax.grid(axis="y", alpha=0.18)
    ax.set_axisbelow(True)
    ax.set_ylim(0, max(values) * 1.12)
    ax.margins(x=0.01)
    ax.tick_params(colors=TEXT_MUTED)
    for spine in ax.spines.values():
        spine.set_color(GRID)
    ax.title.set_color(TEXT)
    ax.xaxis.label.set_color(TEXT)
    ax.yaxis.label.set_color(TEXT)
    for bar, v in zip(bars, values):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + 0.35,
            f"{v:.1f}",
            ha="center",
            va="bottom",
            fontsize=8,
            color=TEXT,
        )
    ax.text(
        0.0,
        -0.17,
        "Peak: 17:00 (30.7) | Quietest: 03:00 (7.7)",
        transform=ax.transAxes,
        fontsize=10,
        color=TEXT_MUTED,
    )
    fig.subplots_adjust(left=0.12, right=0.985, top=0.87, bottom=0.23)
    save(fig, "hourly_avg_clean")


def render_capacity_by_type():
    rows = read_csv("special_capacity_by_type.csv")[:10]
    types = [r["aircraft_type"] for r in rows][::-1]
    seat_movements = [int(r["estimated_seat_movements"]) for r in rows][::-1]
    seats = [int(r["typical_seats"]) for r in rows][::-1]
    movements = [int(r["movements"]) for r in rows][::-1]
    shares = [float(r["share_of_estimated_seats"]) * 100 for r in rows][::-1]

    fig, ax = setup_figure(12.4, 7.7)
    bars = ax.barh(types, seat_movements, color=BLUE, height=0.68, edgecolor="#1e293b")
    ax.set_title("Estimated Seat Capacity by Aircraft Type", loc="left", pad=18, fontweight="bold")
    ax.text(
        0.0,
        1.015,
        "movements × typical seats, using the dominant types in the sample",
        transform=ax.transAxes,
        fontsize=11,
        color=TEXT_MUTED,
    )
    ax.set_xlabel("Estimated seat-movements")
    ax.set_ylabel("Aircraft type")
    ax.grid(axis="x", alpha=0.18)
    ax.set_axisbelow(True)
    ax.set_xlim(0, max(seat_movements) * 1.16)
    ax.tick_params(colors=TEXT_MUTED)
    for spine in ax.spines.values():
        spine.set_color(GRID)
    ax.title.set_color(TEXT)
    ax.xaxis.label.set_color(TEXT)
    ax.yaxis.label.set_color(TEXT)

    for bar, m, s, sm, share in zip(bars, movements, seats, seat_movements, shares):
        ax.text(
            bar.get_width() + max(seat_movements) * 0.006,
            bar.get_y() + bar.get_height() / 2,
            f"{m:,} × {s} = {sm:,} seats ({share:.1f}%)",
            va="center",
            ha="left",
            fontsize=8.5,
            color=TEXT,
        )

    ax.text(
        0.0,
        -0.15,
        "Top five aircraft types account for roughly three-quarters of the estimated seat capacity.",
        transform=ax.transAxes,
        fontsize=10,
        color=TEXT_MUTED,
    )
    fig.subplots_adjust(left=0.14, right=0.985, top=0.87, bottom=0.18)
    save(fig, "special_capacity_by_type_clean")


def render_weekday_breakdown():
    rows = read_csv("weekday_breakdown.csv")
    weekdays = [r["weekday_name"] for r in rows]
    landings = [int(r["landings"]) for r in rows]
    takeoffs = [int(r["takeoffs"]) for r in rows]

    y = np.arange(len(weekdays))
    h = 0.36
    fig, ax = setup_figure(12.8, 7.2)
    ax.barh(y - h / 2, landings, h, label="Landings", color=BLUE, edgecolor="#0f172a")
    ax.barh(y + h / 2, takeoffs, h, label="Takeoffs", color=ORANGE, edgecolor="#0f172a")
    ax.set_yticks(y, weekdays)
    ax.set_title("Landing and Takeoff Movements by Weekday", loc="left", pad=18, fontweight="bold")
    ax.text(
        0.0,
        1.015,
        "Raw sample distribution by weekday in IST",
        transform=ax.transAxes,
        fontsize=11,
        color=TEXT_MUTED,
    )
    ax.set_xlabel("Movements")
    ax.set_ylabel("Weekday")
    ax.grid(axis="x", alpha=0.18)
    ax.set_axisbelow(True)
    ax.legend(frameon=False, loc="upper right")
    ax.set_xlim(0, max(max(landings), max(takeoffs)) * 1.12)
    ax.tick_params(colors=TEXT_MUTED)
    for spine in ax.spines.values():
        spine.set_color(GRID)
    ax.title.set_color(TEXT)
    ax.xaxis.label.set_color(TEXT)
    ax.yaxis.label.set_color(TEXT)
    ax.text(
        0.0,
        -0.15,
        "Saturday leads the sample; Monday is the quietest weekday.",
        transform=ax.transAxes,
        fontsize=10,
        color=TEXT_MUTED,
    )
    fig.subplots_adjust(left=0.12, right=0.985, top=0.87, bottom=0.16)
    save(fig, "weekday_breakdown_clean")


def render_sample_coverage_by_year():
    years = ["2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025", "2026"]
    days = [5, 19, 10, 19, 24, 24, 24, 21, 6]

    fig, ax = setup_figure(12.4, 6.8)
    bars = ax.bar(years, days, color=BLUE, width=0.68, edgecolor="#1e293b")
    ax.set_title("Distinct Sampled Days by Year", loc="left", pad=18, fontweight="bold")
    ax.text(
        0.0,
        1.015,
        "Full sampled days in the flight-run archive, grouped by calendar year",
        transform=ax.transAxes,
        fontsize=11,
        color=TEXT_MUTED,
    )
    ax.set_ylabel("Distinct sampled days", labelpad=16)
    ax.set_xlabel("Year")
    ax.grid(axis="y", alpha=0.18)
    ax.set_axisbelow(True)
    ax.set_ylim(0, max(days) * 1.22)
    ax.tick_params(colors=TEXT_MUTED)
    for spine in ax.spines.values():
        spine.set_color(GRID)
    ax.title.set_color(TEXT)
    ax.xaxis.label.set_color(TEXT)
    ax.yaxis.label.set_color(TEXT)
    for bar, v in zip(bars, days):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + 0.35,
            f"{v}",
            ha="center",
            va="bottom",
            fontsize=9,
            color=TEXT,
        )
    ax.text(
        0.0,
        -0.16,
        "Total: 152 distinct sampled days from 2018-10-01 through 2026-03-02.",
        transform=ax.transAxes,
        fontsize=10,
        color=TEXT_MUTED,
    )
    fig.subplots_adjust(left=0.12, right=0.985, top=0.87, bottom=0.22)
    save(fig, "sample_coverage_by_year_clean")


if __name__ == "__main__":
    render_hourly_avg()
    render_capacity_by_type()
    render_weekday_breakdown()
    render_sample_coverage_by_year()
