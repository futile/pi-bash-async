/** biome-ignore-all lint/suspicious/noExplicitAny: tests drive the extension through a lightweight pi stand-in. */
// Regression tests for this fork's changes: /reload hand-over, the jobs signal and the command display.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderCallText } from "./render.js";
import { createRunningJobsWidget, defaultJobTitle } from "./running-jobs-widget.js";

type IndexModule = typeof import("./index.js");

const directories: string[] = [];

beforeEach(() => vi.stubEnv("PI_BASH_ASYNC_SYNC_WINDOW_MS", "0"));
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// A fresh index module per call, like Pi re-evaluating extensions on /reload.
async function load(): Promise<IndexModule> {
	vi.resetModules();
	return import("./index.js");
}

function instance(mod: IndexModule, mode: "tui" | "print") {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const tools = new Map<string, any>();
	const listeners = new Map<string, () => void>();
	const sent: any[] = [];
	const emitted: any[] = [];
	const statuses: [string, string | undefined][] = [];
	mod.default({
		on: (name: string, fn: any) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		sendMessage: (message: any) => sent.push(message),
		events: {
			on: (channel: string, fn: () => void) => {
				listeners.set(channel, fn);
				return () => listeners.delete(channel);
			},
			emit: (channel: string, data: unknown) => {
				if (channel === mod.JOBS_EVENT) emitted.push(data);
			},
		},
	} as any);
	const ctx = {
		mode,
		hasUI: mode === "tui",
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined },
		isIdle: () => true,
		ui: { setWidget() {}, setStatus: (key: string, text?: string) => statuses.push([key, text]) },
	};
	const emit = async (name: string, event: unknown = {}) => {
		for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
	};
	const start = (command: string, title?: string) =>
		tools.get("bash_async").execute("call", { action: "start", command, title }, undefined, undefined, ctx);
	const completions = () => sent.filter((message) => message.customType === "bash-async-completion");
	return { sent, emitted, statuses, listeners, emit, start, completions };
}

describe("/reload hand-over", () => {
	it("hands a running job to the next instance, which delivers its completion", async () => {
		const old = instance(await load(), "print");
		await old.emit("session_start");
		const started = await old.start("sleep 0.5; echo survived-reload");
		expect(started.details.status).toBe("running");
		await old.emit("session_shutdown", { reason: "reload" });

		const next = instance(await load(), "print");
		await next.emit("session_start");
		await vi.waitFor(() => expect(next.completions()).toHaveLength(1), { timeout: 5000 });
		expect(next.completions()[0].content).toMatch(/survived-reload/);
		expect(old.sent).toHaveLength(0);
		await next.emit("session_shutdown", { reason: "quit" });
	});

	it("still kills running jobs on quit", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-fork-"));
		directories.push(directory);
		const marker = join(directory, "marker");
		const pi = instance(await load(), "print");
		await pi.emit("session_start");
		await pi.start(`sleep 0.5; touch ${marker}`);
		await pi.emit("session_shutdown", { reason: "quit" });
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(existsSync(marker)).toBe(false);
		expect(pi.completions()).toHaveLength(0);
	});
});

describe("jobs signal", () => {
	it("shows the glyph with the job count", async () => {
		const { jobsIndicator } = await load();
		expect(jobsIndicator(1)).toBe("⏳1");
		expect(jobsIndicator(3)).toBe("⏳3");
	});

	it("announces transitions on the bus, answers requests and mirrors the count to the TUI status", async () => {
		const mod = await load();
		const pi = instance(mod, "tui");
		await pi.emit("session_start");
		await pi.start("sleep 0.3", "t");
		await pi.start("sleep 0.3", "t");
		await vi.waitFor(() => expect(pi.emitted.some((update) => update.running === 2)).toBe(true));
		expect(pi.statuses.at(-1)).toEqual(["bash-async", "⏳2"]);
		const update = pi.emitted.find((candidate) => candidate.running === 2);
		expect(update.version).toBe(1);
		expect(update.jobs).toHaveLength(2);
		expect(update.jobs[0].title).toBe("t");

		await vi.waitFor(() => expect(pi.emitted.at(-1)?.running).toBe(0), { timeout: 5000 });
		expect(pi.statuses.at(-1)).toEqual(["bash-async", undefined]);

		const before = pi.emitted.length;
		pi.listeners.get(mod.JOBS_REQUEST_EVENT)?.();
		expect(pi.emitted).toHaveLength(before + 1);
		await pi.emit("session_shutdown", { reason: "quit" });
		expect(pi.listeners.has(mod.JOBS_REQUEST_EVENT)).toBe(false);
	});

	it("announces on the bus without touching the UI in headless sessions", async () => {
		const pi = instance(await load(), "print");
		await pi.emit("session_start");
		await pi.start("sleep 0.2", "t");
		await vi.waitFor(() => expect(pi.emitted.some((update) => update.running === 1)).toBe(true));
		expect(pi.statuses).toHaveLength(0);
		await pi.emit("session_shutdown", { reason: "quit" });
		expect(pi.emitted.at(-1).running).toBe(0);
	});

	it("lets the adopting instance announce a handed-over job after /reload", async () => {
		const old = instance(await load(), "tui");
		await old.emit("session_start");
		await old.start("sleep 2", "t");
		await vi.waitFor(() => expect(old.emitted.some((update) => update.running === 1)).toBe(true));
		await old.emit("session_shutdown", { reason: "reload" });
		const oldCount = old.emitted.length;

		const next = instance(await load(), "tui");
		await next.emit("session_start");
		await vi.waitFor(() => expect(next.emitted.some((update) => update.running === 1)).toBe(true));
		expect(next.statuses.at(-1)).toEqual(["bash-async", "⏳1"]);
		await next.emit("session_shutdown", { reason: "quit" });
		expect(old.emitted).toHaveLength(oldCount);
	});
});

describe("command display", () => {
	it("defaults the title to the one-line command, clipped", () => {
		expect(defaultJobTitle("cd /x &&\n  just build")).toBe("cd /x && just build");
		const long = defaultJobTitle(`echo ${"a".repeat(100)}`);
		expect(long).toHaveLength(60);
		expect(long.endsWith("...")).toBe(true);
		expect(defaultJobTitle("  ")).toBe("bash job");
	});

	it("uses the command as the title when start has none", async () => {
		const pi = instance(await load(), "print");
		const result = await pi.start("cd / && true");
		expect(result.details.title).toBe("cd / && true");
		await pi.emit("session_shutdown", { reason: "quit" });
	});

	it("shows the command in the call row, collapsed to three lines unless expanded", () => {
		const command = "a\nb\nc\nd\ne";
		const text = (...args: Parameters<typeof renderCallText>) => (renderCallText(...args) as any).text;
		expect(text("start", "t", command)).toBe("bash_async start: t\n$ a\nb\nc\n… (2 more lines)");
		expect(text("start", undefined, command, true)).toBe("bash_async start\n$ a\nb\nc\nd\ne");
		expect(text("kill", undefined, undefined)).toBe("bash_async kill");
	});

	it("shows the command after an explicit title in the widget, but not a second copy of a default title", () => {
		const job = (title: string, command: string) =>
			({ id: "j", status: "running", title, command, queuedAt: 0, startedAt: 0 }) as any;
		const render = (entry: any) =>
			createRunningJobsWidget({ requestRender() {} } as any, { fg: (_color: string, text: string) => text } as any, {
				getRunningJobs: () => [entry],
				now: () => 5_000,
			}).render(120)[0];
		expect(render(job("build", "nix build .#x"))).toBe("bash_async · build · $ nix build .#x · 5s");
		expect(render(job(defaultJobTitle("nix build .#x"), "nix build .#x"))).toBe("bash_async · nix build .#x · 5s");
	});
});
