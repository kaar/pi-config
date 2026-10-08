import { writeFileSync } from "node:fs";
import {
	SessionManager,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export interface ChildSession {
	file: string;
	directory: string;
	jsonl: string;
}

/** Capture and serialize synchronously so no source operation can interleave. */
export function captureChild(source: ExtensionContext["sessionManager"], cwd: string): ChildSession {
	const branch = source.getBranch();
	if (!branch.some(hasConversation)) throw new Error("No active conversation branch to clone.");

	// This independent manager allocates metadata and a path, but writes no entries.
	const child = SessionManager.create(cwd, source.getSessionDir() || undefined, {
		parentSession: source.getSessionFile(),
	});
	const file = child.getSessionFile();
	const header = child.getHeader();
	if (!file || !header) throw new Error("Could not allocate a persistent child session.");

	const entries: SessionEntry[] = [];
	let parentId: string | null = null;

	for (const entry of branch) {
		entries.push({ ...entry, parentId });
		parentId = entry.id;
	}
	return {
		file,
		directory: child.getSessionDir(),
		jsonl: `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	};
}

function hasConversation(entry: SessionEntry): boolean {
	return (entry.type === "message" && entry.message.role !== "system")
		|| entry.type === "custom_message"
		|| entry.type === "compaction"
		|| entry.type === "branch_summary";
}

export function persistChild(child: ChildSession): void {
	// Never overwrite a session, and never expose inherited history to other users.
	writeFileSync(child.file, child.jsonl, { flag: "wx", mode: 0o600 });
}
