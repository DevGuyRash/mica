//! Output helpers: human (ANSI when stdout is a TTY) vs `--json`.

use std::io::IsTerminal;

/// Minimal ANSI styling that degrades to plain text when piped.
#[derive(Debug, Clone, Copy)]
pub struct Style {
    enabled: bool,
}

impl Style {
    /// Detect whether stdout wants color.
    pub fn auto() -> Self {
        Style {
            enabled: std::io::stdout().is_terminal(),
        }
    }

    /// Force color on/off (tests).
    pub fn forced(enabled: bool) -> Self {
        Style { enabled }
    }

    /// Wrap `s` in an SGR code when enabled.
    fn paint(&self, code: &str, s: &str) -> String {
        if self.enabled {
            format!("\x1b[{code}m{s}\x1b[0m")
        } else {
            s.to_string()
        }
    }

    /// Bold.
    pub fn bold(&self, s: &str) -> String {
        self.paint("1", s)
    }

    /// Dim / secondary.
    pub fn dim(&self, s: &str) -> String {
        self.paint("2", s)
    }

    /// Green (insertions, success).
    pub fn green(&self, s: &str) -> String {
        self.paint("32", s)
    }

    /// Red (deletions, errors).
    pub fn red(&self, s: &str) -> String {
        self.paint("31", s)
    }

    /// Cyan (identifiers).
    pub fn cyan(&self, s: &str) -> String {
        self.paint("36", s)
    }

    /// Yellow (labels/warnings).
    pub fn yellow(&self, s: &str) -> String {
        self.paint("33", s)
    }
}

/// "3 minutes ago" / "2 days ago" for ledger timestamps.
///
/// Purpose: the versions timeline is unreadable as raw unix millis.
///
/// # Arguments
/// * `ts_ms` - event time (unix millis)
/// * `now_ms` - current time (injected for testability)
///
/// # Returns
/// A short relative-time phrase.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// assert_eq!(mica_cli::output::rel_time(0, 90_000), "1 minute ago");
/// ```
pub fn rel_time(ts_ms: u64, now_ms: u64) -> String {
    let secs = now_ms.saturating_sub(ts_ms) / 1000;
    let (n, unit) = if secs < 5 {
        return "just now".to_string();
    } else if secs < 60 {
        (secs, "second")
    } else if secs < 3600 {
        (secs / 60, "minute")
    } else if secs < 86_400 {
        (secs / 3600, "hour")
    } else if secs < 7 * 86_400 {
        (secs / 86_400, "day")
    } else {
        (secs / (7 * 86_400), "week")
    };
    format!("{n} {unit}{} ago", if n == 1 { "" } else { "s" })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;

    #[test]
    fn rel_time_buckets() {
        assert_eq!(rel_time(0, 3_000), "just now");
        assert_eq!(rel_time(0, 30_000), "30 seconds ago");
        assert_eq!(rel_time(0, 90_000), "1 minute ago");
        assert_eq!(rel_time(0, 7_200_000), "2 hours ago");
        assert_eq!(rel_time(0, 3 * 86_400_000), "3 days ago");
        assert_eq!(rel_time(0, 15 * 86_400_000), "2 weeks ago");
        assert_eq!(rel_time(10, 5), "just now", "clock skew never underflows");
    }

    #[test]
    fn style_paints_only_when_enabled() {
        assert_eq!(Style::forced(false).red("x"), "x");
        assert_eq!(Style::forced(true).red("x"), "\x1b[31mx\x1b[0m");
    }
}
