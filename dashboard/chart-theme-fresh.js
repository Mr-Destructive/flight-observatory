/**
 * Flight Observatory - Chart Theme Configuration
 * Shared configuration for all Chart.js instances to ensure consistency and high-quality UX.
 */

window.CHART_THEME = {
  colors: {
    cyan: '#00daf3',
    orange: '#fbbc00',
    green: '#00e639',
    purple: '#72ff70',
    pink: '#ffdfa0',
    textPrimary: '#dce3f0',
    textSecondary: '#b9ccb2',
    textTertiary: '#84967e',
    border: 'rgba(148, 163, 184, 0.15)',
    grid: 'rgba(148, 163, 184, 0.08)',
    tooltipBg: 'rgba(13, 20, 29, 0.94)',
  },
  fonts: {
    display: '"Space Grotesk", "Inter", sans-serif',
    body: '"Inter", sans-serif',
  },
  
  withAlpha: (color, alpha) => {
    const text = String(color ?? "").trim();
    if (!text) return `rgba(0, 0, 0, ${alpha})`;

    if (text.startsWith("rgba(")) {
      return text.replace(/rgba\(([^)]+)\)/, (match, inner) => {
        const parts = inner.split(",").map((part) => part.trim());
        if (parts.length < 3) return match;
        return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
      });
    }

    if (text.startsWith("rgb(")) {
      const inner = text.slice(4, -1);
      const parts = inner.split(",").map((part) => part.trim());
      if (parts.length >= 3) {
        return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
      }
    }

    const hex = text.replace("#", "");
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    return text;
  },

  // Helper to create a vertical gradient
  getGradient: (ctx, color) => {
    const gradient = ctx.createLinearGradient(0, 0, 0, 400);
    gradient.addColorStop(0, window.CHART_THEME.withAlpha(color, 0.28));
    gradient.addColorStop(1, window.CHART_THEME.withAlpha(color, 0));
    return gradient;
  },

  // Default options for all charts
  defaults: {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 1000,
      easing: 'easeOutQuart',
    },
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        enabled: true,
        mode: 'index',
        intersect: false,
        backgroundColor: 'rgba(13, 20, 29, 0.94)',
        titleColor: '#dce3f0',
        bodyColor: '#b9ccb2',
        borderColor: 'rgba(0, 218, 243, 0.3)',
        borderWidth: 1.5,
        padding: 14,
        cornerRadius: 12,
        displayColors: true,
        boxWidth: 8,
        boxHeight: 8,
        boxPadding: 6,
        usePointStyle: true,
        titleFont: {
          family: '"Space Grotesk", sans-serif',
          size: 14,
          weight: '700',
        },
        bodyFont: {
          family: '"Inter", sans-serif',
          size: 13,
          lineHeight: 1.6,
        },
        footerFont: {
          family: '"Inter", sans-serif',
          size: 11,
        },
        caretSize: 0,
        caretPadding: 20,
        position: 'nearest',
        animation: {
          duration: 200,
        },
        callbacks: {
            title: (tooltipItems) => {
                return tooltipItems[0].label;
            },
            label: (context) => {
                let label = context.dataset.label || '';
                if (label && label !== 'Value') {
                    label += ': ';
                } else {
                    label = '';
                }
                if (context.parsed.y !== null) {
                    label += new Intl.NumberFormat('en-US').format(context.parsed.y);
                } else if (context.parsed !== null) {
                    label += new Intl.NumberFormat('en-US').format(context.parsed);
                }
                return ' ' + label;
            }
        }
      }
    },
    scales: {
      x: {
        grid: {
          display: true,
          color: 'rgba(148, 163, 184, 0.05)',
          drawBorder: false,
        },
        ticks: {
          color: '#84967e',
          font: {
            family: '"Space Grotesk", sans-serif',
            size: 10,
          },
          maxRotation: 0,
          autoSkip: true,
          padding: 8,
        }
      },
      y: {
        grid: {
          display: true,
          color: 'rgba(148, 163, 184, 0.08)',
          drawBorder: false,
        },
        ticks: {
          color: '#84967e',
          font: {
            family: '"Space Grotesk", sans-serif',
            size: 10,
          },
          padding: 8,
          callback: function(value) {
              if (value >= 1000) {
                  return (value / 1000).toFixed(1) + 'k';
              }
              return value;
          }
        }
      }
    }
  },

  // Specialized dataset defaults
  applyDatasetDefaults: (type, color) => {
    const isLine = type === 'line';
    const isDoughnut = type === 'doughnut' || type === 'pie';
    const isBar = type === 'bar';

    if (isDoughnut) {
      return {
        backgroundColor: [
          'rgba(0, 218, 243, 0.7)',
          'rgba(0, 230, 57, 0.7)',
          'rgba(251, 188, 0, 0.7)',
          'rgba(114, 255, 112, 0.7)',
          'rgba(255, 223, 160, 0.7)',
          'rgba(236, 72, 153, 0.7)',
        ],
        borderWidth: 0,
        hoverOffset: 12,
      };
    }

    return {
      label: 'Value',
      borderColor: color,
      backgroundColor: isLine
        ? window.CHART_THEME.withAlpha(color, 0.08)
        : window.CHART_THEME.withAlpha(color, 0.22),
      borderWidth: 2,
      pointRadius: isLine ? 2 : 0,
      pointHoverRadius: isLine ? 5 : 0,
      pointBackgroundColor: color,
      pointBorderColor: '#0d141d',
      pointBorderWidth: 1.5,
      tension: isLine ? 0.35 : 0,
      fill: isLine,
      borderRadius: isBar ? 4 : 0,
    };
  }
};

(function () {
  const DARK = {
    colors: {
      cyan: '#00daf3',
      orange: '#fbbc00',
      green: '#00e639',
      purple: '#72ff70',
      pink: '#ffdfa0',
      textPrimary: '#dce3f0',
      textSecondary: '#b9ccb2',
      textTertiary: '#84967e',
      border: 'rgba(148, 163, 184, 0.15)',
      grid: 'rgba(148, 163, 184, 0.08)',
      tooltipBg: 'rgba(13, 20, 29, 0.94)',
      tooltipText: '#dce3f0',
    },
    chart: {
      color: '#dce3f0',
      font: { family: '"Space Grotesk", "Inter", system-ui, sans-serif', size: 11 },
      borderColor: 'rgba(148, 163, 184, 0.15)',
      gridColor: 'rgba(148, 163, 184, 0.08)',
    },
  };

  const LIGHT = {
    colors: {
      cyan: '#0284c7',
      orange: '#d97706',
      green: '#16a34a',
      purple: '#7c3aed',
      pink: '#db2777',
      textPrimary: '#0f172a',
      textSecondary: '#334155',
      textTertiary: '#64748b',
      border: 'rgba(15, 23, 42, 0.12)',
      grid: 'rgba(15, 23, 42, 0.08)',
      tooltipBg: 'rgba(255, 255, 255, 0.98)',
      tooltipText: '#0f172a',
    },
    chart: {
      color: '#334155',
      font: { family: '"Space Grotesk", "Inter", system-ui, sans-serif', size: 11 },
      borderColor: 'rgba(15, 23, 42, 0.12)',
      gridColor: 'rgba(15, 23, 42, 0.08)',
    },
  };

  function themeName(theme) {
    if (theme) return theme === "light" ? "light" : "dark";
    return document.body.classList.contains("light-mode") ? "light" : "dark";
  }

  function buildDefaults(palette) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 1000,
        easing: 'easeOutQuart',
      },
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          enabled: true,
          mode: 'index',
          intersect: false,
          backgroundColor: palette.colors.tooltipBg,
          titleColor: palette.colors.tooltipText,
          bodyColor: palette.colors.textSecondary,
          borderColor: palette.colors.border,
          borderWidth: 1.5,
          padding: 14,
          cornerRadius: 12,
          displayColors: true,
          boxWidth: 8,
          boxHeight: 8,
          boxPadding: 6,
          usePointStyle: true,
          titleFont: {
            family: '"Space Grotesk", sans-serif',
            size: 14,
            weight: '700',
          },
          bodyFont: {
            family: '"Inter", sans-serif',
            size: 13,
            lineHeight: 1.6,
          },
          footerFont: {
            family: '"Inter", sans-serif',
            size: 11,
          },
          caretSize: 0,
          caretPadding: 20,
          position: 'nearest',
          animation: {
            duration: 200,
          },
        },
      },
      scales: {
        x: {
          grid: {
            display: true,
            color: palette.chart.gridColor,
            drawBorder: false,
          },
          ticks: {
            color: palette.chart.color,
            font: {
              family: '"Space Grotesk", sans-serif',
              size: 10,
            },
            maxRotation: 0,
            autoSkip: true,
            padding: 8,
          },
        },
        y: {
          grid: {
            display: true,
            color: palette.chart.gridColor,
            drawBorder: false,
          },
          ticks: {
            color: palette.chart.color,
            font: {
              family: '"Space Grotesk", sans-serif',
              size: 10,
            },
            padding: 8,
            callback: function (value) {
              if (value >= 1000) {
                return (value / 1000).toFixed(1) + 'k';
              }
              return value;
            },
          },
        },
      },
    };
  }

  window.CHART_THEME.getTheme = window.CHART_THEME.getTheme || (() => themeName());
  window.CHART_THEME.applyTheme = function (theme) {
    const next = themeName(theme);
    const palette = next === "light" ? LIGHT : DARK;
    Object.assign(window.CHART_THEME.colors, palette.colors);
    window.CHART_THEME.defaults = buildDefaults(palette);
    if (window.Chart) {
      Chart.defaults.color = palette.chart.color;
      Chart.defaults.font = {
        family: palette.chart.font.family,
        size: palette.chart.font.size,
      };
      Chart.defaults.plugins.legend.labels.usePointStyle = true;
    }
    return window.CHART_THEME;
  };

  window.CHART_THEME.applyTheme(window.CHART_THEME.getTheme());
})();
