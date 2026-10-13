export interface HighlightStyle {
	fg?: string;
	bg?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	reverse?: boolean;
}

export type Highlight = [row: number, startByte: number, endByte: number, group: number, toEndOfLine: boolean];

export interface HighlightedText {
	lines: string[];
	groups: HighlightStyle[];
	highlights: Highlight[];
}

const ESCAPE_SEQUENCE = /\x1b\[([0-9;:]*)([\x20-\x2f]*[@-~])|\x1b[\]P^_][\s\S]*?(?:\x07|\x1b\\)|\x1b[\s\S]?/g;

const BASIC_COLORS = [
	"#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
	"#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
];

const hex = (r: number, g: number, b: number) =>
	`#${[r, g, b].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;

function paletteColor(index: number): string | undefined {
	if (index < 0 || index > 255) return undefined;
	if (index < 16) return BASIC_COLORS[index];
	if (index < 232) {
		const level = (value: number) => (value === 0 ? 0 : 55 + value * 40);
		const cube = index - 16;
		return hex(level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6));
	}
	const gray = 8 + (index - 232) * 10;
	return hex(gray, gray, gray);
}

function readExtendedColor(params: number[], i: number): [color: string | undefined, consumed: number] {
	if (params[i + 1] === 5) return [paletteColor(params[i + 2] ?? -1), 2];
	if (params[i + 1] === 2) return [hex(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0), 4];
	return [undefined, 0];
}

function applySgr(style: HighlightStyle, rawParams: string): HighlightStyle {
	const params = rawParams === "" ? [0] : rawParams.split(/[;:]/).map((value) => (value === "" ? 0 : Number(value)));
	let next: HighlightStyle = { ...style };
	for (let i = 0; i < params.length; i++) {
		const code = params[i];
		if (code === 0) next = {};
		else if (code === 1) next.bold = true;
		else if (code === 3) next.italic = true;
		else if (code === 4) next.underline = true;
		else if (code === 7) next.reverse = true;
		else if (code === 9) next.strikethrough = true;
		else if (code === 22) next.bold = undefined;
		else if (code === 23) next.italic = undefined;
		else if (code === 24) next.underline = undefined;
		else if (code === 27) next.reverse = undefined;
		else if (code === 29) next.strikethrough = undefined;
		else if (code >= 30 && code <= 37) next.fg = BASIC_COLORS[code - 30];
		else if (code >= 90 && code <= 97) next.fg = BASIC_COLORS[code - 90 + 8];
		else if (code === 39) next.fg = undefined;
		else if (code >= 40 && code <= 47) next.bg = BASIC_COLORS[code - 40];
		else if (code >= 100 && code <= 107) next.bg = BASIC_COLORS[code - 100 + 8];
		else if (code === 49) next.bg = undefined;
		else if (code === 38 || code === 48 || code === 58) {
			const [color, consumed] = readExtendedColor(params, i);
			if (code === 38) next.fg = color;
			if (code === 48) next.bg = color;
			i += consumed;
		}
	}
	return next;
}

function styleKey(style: HighlightStyle): string {
	return JSON.stringify([style.fg, style.bg, style.bold, style.italic, style.underline, style.strikethrough, style.reverse]);
}

const isPlain = (style: HighlightStyle) => Object.values(style).every((value) => value === undefined);

export function ansiToHighlights(ansiLines: readonly string[]): HighlightedText {
	const groups: HighlightStyle[] = [];
	const groupIndex = new Map<string, number>();
	const highlights: Highlight[] = [];
	const lines: string[] = [];

	const groupFor = (style: HighlightStyle) => {
		const key = styleKey(style);
		let index = groupIndex.get(key);
		if (index === undefined) {
			index = groups.length;
			groups.push(style);
			groupIndex.set(key, index);
		}
		return index;
	};

	ansiLines.forEach((ansiLine, row) => {
		const segments: { text: string; style: HighlightStyle }[] = [];
		let style: HighlightStyle = {};
		let cursor = 0;
		for (const match of ansiLine.matchAll(ESCAPE_SEQUENCE)) {
			segments.push({ text: ansiLine.slice(cursor, match.index), style });
			if (match[2] === "m") style = applySgr(style, match[1]);
			cursor = match.index + match[0].length;
		}
		segments.push({ text: ansiLine.slice(cursor), style });

		const text = segments.map((segment) => segment.text).join("");
		const trimmed = text.trimEnd();
		const trimmedBytes = Buffer.byteLength(trimmed);
		lines.push(trimmed);

		let byte = 0;
		for (const segment of segments) {
			const start = byte;
			byte += Buffer.byteLength(segment.text);
			if (!segment.text || isPlain(segment.style)) continue;
			const end = Math.min(byte, trimmedBytes);
			const toEndOfLine = byte >= trimmedBytes && segment.style.bg !== undefined;
			if (end > start || toEndOfLine) {
				highlights.push([row, Math.min(start, trimmedBytes), end, groupFor(segment.style), toEndOfLine]);
			}
		}
	});

	return { lines, groups, highlights };
}
