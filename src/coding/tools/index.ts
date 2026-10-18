import type { Tool } from "@/foundation/tools";

import { defineApplyPatchTool } from "./apply-patch";
import { defineBashTool } from "./bash";
import { defineFileInfoTool } from "./file-info";
import { defineGlobSearchTool } from "./glob-search";
import { defineGrepSearchTool } from "./grep-search";
import { defineListFilesTool } from "./list-files";
import { defineMkdirTool } from "./mkdir";
import { defineMovePathTool } from "./move-path";
import { defineReadFileTool } from "./read-file";
import { defineStrReplaceTool } from "./str-replace";
import { defineWriteFileTool } from "./write-file";

export interface DefineCodingToolsOptions {
    cwd: string;
    bashTimeoutMs?: number;
    maxOutputCharacters?: number;
    maxResults?: number;
}

export function defineCodingTools(options: DefineCodingToolsOptions): Tool[] {
    return [
        defineFileInfoTool(options),
        defineListFilesTool(options),
        defineGlobSearchTool(options),
        defineGrepSearchTool(options),
        defineReadFileTool({ cwd: options.cwd, maxCharacters: options.maxOutputCharacters }),
        defineMkdirTool(options),
        defineWriteFileTool(options),
        defineStrReplaceTool(options),
        defineApplyPatchTool(options),
        defineMovePathTool(options),
        defineBashTool({
            cwd: options.cwd,
            timeoutMs: options.bashTimeoutMs,
            maxOutputCharacters: options.maxOutputCharacters,
        }),
    ];
}

export {
    defineApplyPatchTool,
    defineBashTool,
    defineFileInfoTool,
    defineGlobSearchTool,
    defineGrepSearchTool,
    defineListFilesTool,
    defineMkdirTool,
    defineMovePathTool,
    defineReadFileTool,
    defineStrReplaceTool,
    defineWriteFileTool,
};
