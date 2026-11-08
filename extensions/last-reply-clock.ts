/**
 * Reply Clock
 *
 * Puts "when did the agent last reply, and how long ago was that" on the footer's
 * existing stats line instead of an extra row.
 *
 * Replacing the footer means reproducing the built-in layout, so this mirrors
 * `dist/modes/interactive/components/footer.js` for pwd, tokens, cost, context, and
 * model. Three built-in details are not reachable from the extension API and are
 * omitted: the routed-model suffix for virtual models, the `(sub)` subscription
 * marker, and the `(auto)` compaction indicator.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Theme = ReturnType<typeof themeOf>;
const themeOf = (ctx: ExtensionContext) => ctx.ui.theme;

function fmtTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function fmtCounter(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Coarse relative age: precise seconds only while they are what you care about. */
function fmtAge(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 10) return "just now";
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ${m % 60}m ago`;
	return `${Math.floor(h / 24)}d ago`;
}

/** Absolute stamp, widened when the reply is not from today. */
function fmtStamp(ts: number): string {
	const then = new Date(ts);
	const now = new Date();
	const time = then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (then.toDateString() === now.toDateString()) return time;
	if (then.getFullYear() === now.getFullYear()) {
		return `${then.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
	}
	return `${then.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })} ${time}`;
}

export default function (pi: ExtensionAPI) {
	let lastReplyAt: number | null = null;
	let lastReplyTook: number | null = null;
	let runStartedAt: number | null = null;
	let mounted = false;

	function recordLastAssistant(ctx: ExtensionContext) {
		lastReplyAt = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const ts = (entry.message as { timestamp?: number }).timestamp;
				if (typeof ts === "number") lastReplyAt = ts;
			}
		}
	}

	/** The reply status segment: a freshness glyph plus relative and absolute time. */
	function replySegment(theme: Theme, now: number): string {
		if (runStartedAt !== null) {
			const head = theme.fg("accent", `◌ ${fmtCounter(now - runStartedAt)}`);
			if (lastReplyAt === null) return head;
			return `${head} ${theme.fg("dim", `· replied ${fmtStamp(lastReplyAt)}`)}`;
		}

		if (lastReplyAt === null) return theme.fg("dim", "● no reply yet");

		const age = now - lastReplyAt;
		const color = age < 60_000 ? "success" : age < 30 * 60_000 ? "accent" : "dim";
		const glyph = age < 60_000 ? "●" : age < 30 * 60_000 ? "◐" : "○";
		const parts = [theme.fg(color, `${glyph} ${fmtAge(age)}`)];
		if (age >= 60_000) parts.push(theme.fg("dim", fmtStamp(lastReplyAt)));
		if (lastReplyTook !== null && lastReplyTook >= 3000) {
			parts.push(theme.fg("dim", `took ${fmtCounter(lastReplyTook)}`));
		}
		return parts.join(theme.fg("dim", " · "));
	}

	function mountFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			mounted = true;

			// One repaint per second keeps the relative counter live. Cheap because the
			// render path below memoizes the session-wide usage scan.
			let ticker: ReturnType<typeof setInterval> | null = setInterval(() => tui.requestRender(), 1000);

			// Usage totals are a full-session scan; cache them per entry count and model.
			let cache: {
				count: number;
				leaf: string | null;
				model: string | undefined;
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				cost: number;
				hitRate: number | undefined;
			} | null = null;

			return {
				dispose() {
					mounted = false;
					if (ticker) clearInterval(ticker);
					ticker = null;
					unsubscribe();
				},
				invalidate() {
					cache = null;
				},
				render(width: number): string[] {
					const entries = ctx.sessionManager.getEntries();
					const leaf = ctx.sessionManager.getLeafId();
					const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

					if (!cache || cache.count !== entries.length || cache.leaf !== leaf || cache.model !== modelKey) {
						let input = 0,
							output = 0,
							cacheRead = 0,
							cacheWrite = 0,
							cost = 0,
							hitRate: number | undefined;
						const add = (usage: {
							input: number;
							output: number;
							cacheRead: number;
							cacheWrite: number;
							cost: { total: number };
						}) => {
							input += usage.input;
							output += usage.output;
							cacheRead += usage.cacheRead;
							cacheWrite += usage.cacheWrite;
							cost += usage.cost.total;
							const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
							hitRate = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
						};
						for (const entry of entries) {
							if (entry.type === "usage") add(entry.usage);
							else if (entry.type === "message" && entry.message.role === "assistant") add(entry.message.usage);
							else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
								add(entry.message.usage);
							} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
								add(entry.usage);
							}
						}
						cache = {
							count: entries.length,
							leaf,
							model: modelKey,
							input,
							output,
							cacheRead,
							cacheWrite,
							cost,
							hitRate,
						};
					}

					const now = Date.now();
					const usage = cache;

					// Line 1: pwd (branch) • session name
					let pwd = ctx.sessionManager.getCwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					// Line 2 left: reply status first so narrowing the terminal never hides it.
					const left: string[] = [replySegment(theme, now)];
					const stats: string[] = [];
					if (usage.input) stats.push(`↑${fmtTokens(usage.input)}`);
					if (usage.output) stats.push(`↓${fmtTokens(usage.output)}`);
					if (usage.cacheRead) stats.push(`R${fmtTokens(usage.cacheRead)}`);
					if (usage.cacheWrite) stats.push(`W${fmtTokens(usage.cacheWrite)}`);
					if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && usage.hitRate !== undefined) {
						stats.push(`CH${usage.hitRate.toFixed(1)}%`);
					}
					if (usage.cost) stats.push(`$${usage.cost.toFixed(3)}`);

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const percentValue = contextUsage?.percent ?? 0;
					const percentDisplay =
						contextUsage?.percent != null
							? `${percentValue.toFixed(1)}%/${fmtTokens(contextWindow)}`
							: `?/${fmtTokens(contextWindow)}`;
					stats.push(
						percentValue > 90
							? theme.fg("error", percentDisplay)
							: percentValue > 70
								? theme.fg("warning", percentDisplay)
								: percentDisplay,
					);
					if (stats.length) left.push(theme.fg("dim", stats.join(" ")));

					let leftText = left.join("  ");

					// Line 2 right: model, thinking level, provider when more than one is available.
					let right = ctx.model?.id || "no-model";
					if (ctx.model?.reasoning) {
						const level = ctx.thinkingLevel || "off";
						right = level === "off" ? `${right} • thinking off` : `${right} • ${level}`;
					}
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						const withProvider = `(${ctx.model.provider}) ${right}`;
						if (visibleWidth(leftText) + 2 + visibleWidth(withProvider) <= width) right = withProvider;
					}

					const leftWidth = visibleWidth(leftText);
					const rightWidth = visibleWidth(right);
					let statsLine: string;
					if (leftWidth + 2 + rightWidth <= width) {
						statsLine = leftText + " ".repeat(width - leftWidth - rightWidth) + right;
					} else if (width - leftWidth - 2 > 0) {
						const truncated = truncateToWidth(right, width - leftWidth - 2, "");
						statsLine = leftText + " ".repeat(Math.max(0, width - leftWidth - visibleWidth(truncated))) + truncated;
					} else {
						leftText = truncateToWidth(leftText, width, theme.fg("dim", "..."));
						statsLine = leftText;
					}

					const lines = [
						truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
						statsLine,
					];

					// Keep other extensions' status texts, but only when they exist.
					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const text = Array.from(statuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, value]) => value.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
							.join(" ");
						lines.push(truncateToWidth(text, width, theme.fg("dim", "...")));
					}
					return lines;
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		runStartedAt = null;
		lastReplyTook = null;
		recordLastAssistant(ctx);
		mountFooter(ctx);
	});

	pi.on("agent_start", async () => {
		runStartedAt = Date.now();
	});

	pi.on("agent_settled", async (event) => {
		if (runStartedAt !== null && !event.aborted) {
			lastReplyTook = Date.now() - runStartedAt;
			lastReplyAt = Date.now();
		}
		runStartedAt = null;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (mounted) ctx.ui.setFooter(undefined);
		mounted = false;
	});
}
