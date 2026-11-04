import { imageGenerateTool } from "./image-generate.js";
import { postizCheckPostTool } from "./postiz-check-post.js";
import { postizUploadImageTool } from "./postiz-upload-image.js";
import type { McpTool } from "../types.js";

/**
 * The tools this server publishes.
 *
 * Kept to the three that V1 shipped as drop-in TypeScript files. The `postiz_*` publishing
 * tools themselves arrive from the remote Postiz MCP server and are not duplicated here.
 */
export const tools: McpTool[] = [imageGenerateTool, postizCheckPostTool, postizUploadImageTool];
