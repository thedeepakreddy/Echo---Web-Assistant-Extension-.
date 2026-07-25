"use strict";
(self["webpackChunkextension"] = self["webpackChunkextension"] || []).push([["node_modules_anthropic-ai_sdk_tools_agent-toolset_node_browser_mjs"],{

/***/ "./node_modules/@anthropic-ai/sdk/tools/agent-toolset/node.browser.mjs"
/*!*****************************************************************************!*\
  !*** ./node_modules/@anthropic-ai/sdk/tools/agent-toolset/node.browser.mjs ***!
  \*****************************************************************************/
(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BashSession: () => (/* binding */ BashSession),
/* harmony export */   betaAgentToolset20260401: () => (/* binding */ betaAgentToolset20260401),
/* harmony export */   betaBashTool: () => (/* binding */ betaBashTool),
/* harmony export */   betaEditTool: () => (/* binding */ betaEditTool),
/* harmony export */   betaGlobTool: () => (/* binding */ betaGlobTool),
/* harmony export */   betaGrepTool: () => (/* binding */ betaGrepTool),
/* harmony export */   betaReadTool: () => (/* binding */ betaReadTool),
/* harmony export */   betaWriteTool: () => (/* binding */ betaWriteTool),
/* harmony export */   extractSkillArchive: () => (/* binding */ extractSkillArchive),
/* harmony export */   resolvePath: () => (/* binding */ resolvePath),
/* harmony export */   resolveSkillVersion: () => (/* binding */ resolveSkillVersion),
/* harmony export */   setupSkills: () => (/* binding */ setupSkills)
/* harmony export */ });
/* harmony import */ var _core_error_mjs__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../../core/error.mjs */ "./node_modules/@anthropic-ai/sdk/core/error.mjs");
/**
 * Browser stub for `tools/agent-toolset/node`.
 *
 * The real module implements the `agent_toolset_20260401` tools on top of Node
 * built-ins (`node:child_process`, `node:fs`, …), which browser bundlers cannot
 * resolve. The `browser` field in `package.json` substitutes this stub in
 * browser builds so the SDK bundles cleanly for web targets; Node runtimes and
 * node-target bundles ignore the mapping and load the real implementation.
 *
 * Every value export here throws an {@link AnthropicError} when used — the
 * agent toolset only works in Node.js or a Node-compatible runtime. Type
 * exports are re-exported from the real module (erased at build time), so
 * type-level usage is unaffected.
 */

function nodeOnly(name) {
    throw new _core_error_mjs__WEBPACK_IMPORTED_MODULE_0__.AnthropicError(`${name} requires Node.js or a Node-compatible runtime`);
}
function setupSkills(_ctx) {
    return nodeOnly('setupSkills');
}
function resolveSkillVersion(_client, _skillId, _version) {
    return nodeOnly('resolveSkillVersion');
}
function extractSkillArchive(_resp, _dest) {
    return nodeOnly('extractSkillArchive');
}
function betaAgentToolset20260401(_ctx) {
    return nodeOnly('betaAgentToolset20260401');
}
function resolvePath(_ctx, _p) {
    return nodeOnly('resolvePath');
}
class BashSession {
    constructor(_dir, _env) {
        nodeOnly('BashSession');
    }
    get closed() {
        return nodeOnly('BashSession');
    }
    exec(_command, _opts = {}) {
        return nodeOnly('BashSession');
    }
    close() {
        nodeOnly('BashSession');
    }
}
function betaBashTool(_ctx) {
    return nodeOnly('betaBashTool');
}
function betaReadTool(_ctx) {
    return nodeOnly('betaReadTool');
}
function betaWriteTool(_ctx) {
    return nodeOnly('betaWriteTool');
}
function betaEditTool(_ctx) {
    return nodeOnly('betaEditTool');
}
function betaGlobTool(_ctx) {
    return nodeOnly('betaGlobTool');
}
function betaGrepTool(_ctx) {
    return nodeOnly('betaGrepTool');
}
//# sourceMappingURL=node.browser.mjs.map

/***/ }

}]);