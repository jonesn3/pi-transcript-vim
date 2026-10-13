import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	isKeyRelease,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	type KeyId,
	type TUI,
} from "@earendil-works/pi-tui";
import { ansiToHighlights } from "./ansi.ts";

const TOGGLE_KEY: KeyId = "ctrl+q";

type Direction = 1 | -1;

interface SearchOverlay {
	isFocused(): boolean;
	focus(): void;
	unfocus(): void;
}

// pi exposes no public API for transcript search or prompt jumps, so these TuiAltScreen
// members are private in its type declarations and may change between pi releases.
interface ScrollViewHandle {
	viewportHeight: number;
	scrollTop: number;
}

interface LayoutBox {
	scrollView?: unknown;
	scrollContentLines?: readonly string[];
	children: LayoutBox[];
}

interface TranscriptViewport {
	scrollBy(lines: number): void;
	scrollToTop(): void;
	scrollToBottom(): void;
	scrollToPrompt(direction: Direction): void;
	toggleSearch(): void;
	closeSearch(): void;
	navigateSearch(direction: Direction): void;
	hasOverlay(): boolean;
	getPrimaryScrollView(): ScrollViewHandle;
	requestRender(force?: boolean): void;
	start(): void;
	stop(): void;
	activeSearch?: { overlay?: SearchOverlay };
	currentLayout?: { root: LayoutBox };
}

function asViewport(tui: TUI): TranscriptViewport | undefined {
	const candidate = tui as unknown as Partial<TranscriptViewport>;
	const required = ["scrollBy", "scrollToTop", "scrollToBottom", "scrollToPrompt", "toggleSearch", "closeSearch", "navigateSearch", "getPrimaryScrollView"] as const;
	return required.every((name) => typeof candidate[name] === "function") ? (candidate as TranscriptViewport) : undefined;
}

function printableChar(data: string): string | undefined {
	if (data.length === 1 && data >= " " && data !== "\x7f") return data;
	return decodeKittyPrintable(data);
}

function transcriptLines(vp: TranscriptViewport): string[] | undefined {
	const scrollView = vp.getPrimaryScrollView();
	const find = (box: LayoutBox): LayoutBox | undefined =>
		box.scrollView === scrollView ? box : box.children.map(find).find(Boolean);
	const root = vp.currentLayout?.root;
	const lines = root ? find(root)?.scrollContentLines : undefined;
	return lines ? [...lines] : undefined;
}

function nvimViewerScript(dataFile: string, line: number): string {
	return `
local data = vim.json.decode(table.concat(vim.fn.readfile(${JSON.stringify(dataFile)}), "\\n"))
local buf = vim.api.nvim_get_current_buf()
vim.bo[buf].buftype = "nofile"
vim.bo[buf].bufhidden = "wipe"
vim.bo[buf].swapfile = false
vim.api.nvim_buf_set_name(buf, "pi-transcript")
vim.api.nvim_buf_set_lines(buf, 0, -1, false, data.lines)
local ns = vim.api.nvim_create_namespace("pi_transcript")
for index, style in ipairs(data.groups) do
  vim.api.nvim_set_hl(0, "PiTranscript" .. (index - 1), style)
end
for _, h in ipairs(data.highlights) do
  local row, start_col, end_col, group, to_eol = h[1], h[2], h[3], h[4], h[5]
  vim.api.nvim_buf_set_extmark(buf, ns, row, start_col, {
    end_row = to_eol and row + 1 or row,
    end_col = to_eol and 0 or end_col,
    hl_group = "PiTranscript" .. group,
    hl_eol = to_eol,
    strict = false,
  })
end
vim.bo[buf].modifiable = false
vim.bo[buf].readonly = true
vim.bo[buf].modified = false
vim.api.nvim_win_set_cursor(0, { math.min(${line}, vim.api.nvim_buf_line_count(buf)), 0 })
vim.cmd("normal! zt")
`;
}

function prepareEditor(command: string, directory: string, lines: string[], line: number): string[] {
	const name = basename(command);
	if (name === "nvim") {
		const dataFile = join(directory, "transcript.json");
		const script = join(directory, "viewer.lua");
		writeFileSync(dataFile, JSON.stringify(ansiToHighlights(lines)), "utf-8");
		writeFileSync(script, nvimViewerScript(dataFile, line), "utf-8");
		return ["-n", "-S", script];
	}
	const file = join(directory, "transcript.md");
	writeFileSync(file, `${lines.map((text) => stripTerminalSequences(text).trimEnd()).join("\n")}\n`, "utf-8");
	if (/^vim?$/.test(name)) return [`+${line}`, "-c", "normal! zt", "-R", file];
	if (name === "nano") return [`+${line}`, "-v", file];
	return [file];
}

function runEditor(command: string, args: string[]): Promise<number | null> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.on("error", () => resolve(null));
		child.on("close", (code) => resolve(code));
	});
}

const HELP = "j/k ^e/^y line  ^d/^u d/u half  ^f/^b page  gg/G  {/} prompt  / n N search  v/^q $EDITOR  i/q/esc exit";

export default function (pi: ExtensionAPI) {
	let viewport: TranscriptViewport | undefined;
	let active = false;
	let count = "";
	let pendingG = false;
	let unsubscribe: (() => void) | undefined;
	let editorOpen = false;
	let currentCtx: ExtensionContext | undefined;

	const openInEditor = async (vp: TranscriptViewport) => {
		const lines = transcriptLines(vp);
		if (!lines) {
			currentCtx?.ui.notify("Could not read the transcript", "error");
			return;
		}
		const [command, ...baseArgs] = (process.env.VISUAL || process.env.EDITOR || "nvim").split(" ");
		const directory = mkdtempSync(join(tmpdir(), "pi-transcript-"));
		const args = prepareEditor(command, directory, lines, vp.getPrimaryScrollView().scrollTop + 1);
		editorOpen = true;
		vp.stop();
		try {
			const code = await runEditor(command, [...baseArgs, ...args]);
			if (code === null) currentCtx?.ui.notify(`Could not start ${command}`, "error");
		} finally {
			rmSync(directory, { recursive: true, force: true });
			editorOpen = false;
			vp.start();
			vp.requestRender(true);
		}
	};

	const takeCount = () => {
		const n = Math.max(1, Number.parseInt(count || "1", 10));
		count = "";
		return n;
	};

	const setActive = (value: boolean) => {
		active = value;
		count = "";
		pendingG = false;
		if (!value) viewport?.closeSearch();
		viewport?.requestRender();
	};

	const viewportHeight = (vp: TranscriptViewport) => vp.getPrimaryScrollView().viewportHeight;

	const handleCtrl = (vp: TranscriptViewport, data: string): boolean => {
		const half = () => Math.max(1, Math.floor(viewportHeight(vp) / 2));
		const page = () => Math.max(1, viewportHeight(vp) - 2);
		if (matchesKey(data, "ctrl+d")) vp.scrollBy(half() * takeCount());
		else if (matchesKey(data, "ctrl+u")) vp.scrollBy(-half() * takeCount());
		else if (matchesKey(data, "ctrl+f")) vp.scrollBy(page() * takeCount());
		else if (matchesKey(data, "ctrl+b")) vp.scrollBy(-page() * takeCount());
		else if (matchesKey(data, "ctrl+e")) vp.scrollBy(takeCount());
		else if (matchesKey(data, "ctrl+y")) vp.scrollBy(-takeCount());
		else return false;
		return true;
	};

	const handleChar = (vp: TranscriptViewport, char: string) => {
		if (/^[1-9]$/.test(char) || (char === "0" && count)) {
			count += char;
			return;
		}
		const wasPendingG = pendingG;
		pendingG = false;
		const half = Math.max(1, Math.floor(viewportHeight(vp) / 2));
		switch (char) {
			case "j":
				vp.scrollBy(takeCount());
				break;
			case "k":
				vp.scrollBy(-takeCount());
				break;
			case "d":
				vp.scrollBy(half * takeCount());
				break;
			case "u":
				vp.scrollBy(-half * takeCount());
				break;
			case "g":
				if (wasPendingG) {
					count = "";
					vp.scrollToTop();
				} else {
					pendingG = true;
				}
				break;
			case "G":
				count = "";
				vp.scrollToBottom();
				break;
			case "{":
				for (let i = takeCount(); i > 0; i--) vp.scrollToPrompt(-1);
				break;
			case "}":
				for (let i = takeCount(); i > 0; i--) vp.scrollToPrompt(1);
				break;
			case "/":
				count = "";
				if (vp.activeSearch?.overlay) vp.activeSearch.overlay.focus();
				else vp.toggleSearch();
				vp.requestRender();
				break;
			case "n":
				for (let i = takeCount(); i > 0; i--) vp.navigateSearch(1);
				break;
			case "N":
				for (let i = takeCount(); i > 0; i--) vp.navigateSearch(-1);
				break;
			case "v":
				count = "";
				void openInEditor(vp);
				break;
			case "i":
			case "q":
				setActive(false);
				break;
			default:
				count = "";
		}
	};

	const handleInput = (data: string) => {
		const vp = viewport;
		if (!vp || editorOpen) return undefined;

		if (!active) {
			if (!matchesKey(data, TOGGLE_KEY) || vp.hasOverlay()) return undefined;
			if (!isKeyRelease(data)) setActive(true);
			return { consume: true };
		}

		const searchOverlay = vp.activeSearch?.overlay;
		if (searchOverlay?.isFocused()) {
			if (!matchesKey(data, "enter")) return undefined;
			if (!isKeyRelease(data)) {
				searchOverlay.unfocus();
				vp.requestRender();
			}
			return { consume: true };
		}

		if (vp.hasOverlay() && !vp.activeSearch) {
			setActive(false);
			return undefined;
		}

		if (isKeyRelease(data)) return { consume: true };

		if (matchesKey(data, TOGGLE_KEY)) {
			count = "";
			void openInEditor(vp).then(() => setActive(false));
			return { consume: true };
		}

		if (matchesKey(data, "escape")) {
			if (vp.activeSearch) {
				vp.closeSearch();
			} else {
				setActive(false);
			}
			return { consume: true };
		}

		if (handleCtrl(vp, data)) return { consume: true };

		const char = printableChar(data);
		if (char) handleChar(vp, char);
		return { consume: true };
	};

	const indicator = (theme: Theme) => ({
		render: (width: number) => (active ? [truncateToWidth(theme.fg("accent", `-- TRANSCRIPT --  ${theme.fg("muted", HELP)}`), width)] : []),
		invalidate: () => {},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		currentCtx = ctx;
		ctx.ui.setWidget("transcript-vim", (tui, theme) => {
			viewport = asViewport(tui);
			return indicator(theme);
		});
		unsubscribe?.();
		unsubscribe = ctx.ui.onTerminalInput(handleInput);
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		viewport = undefined;
		currentCtx = undefined;
		active = false;
	});
}
