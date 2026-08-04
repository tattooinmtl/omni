// Fixed /neuralview architecture-node ids — NewPlanConversion.md's own
// diagram (Memory Coordinator -> L0 / Chat Memory / Skills / Wiki /
// CodeGraph / Feedback). Split into its own zero-dependency module so both
// galaxy-graph.mjs (which builds the node/edge list) and anything that
// PUBLISHES activity for those nodes (core/memory-provider.mjs,
// core/config.mjs, core/agent.mjs) can reference the same ids without a
// circular import between the graph builder and the memory provider.

export const COORDINATOR_ID = "sys-coordinator";
export const L0_ID = "sys-l0";
export const CHAT_MEMORY_ID = "sys-chatmem";
export const SKILLS_ID = "sys-skills";
export const WIKI_ID = "sys-wiki";
export const CODEGRAPH_ID = "sys-codegraph";
export const FEEDBACK_ID = "sys-feedback";
export const OKF_ROOT_ID = "okf-root";
