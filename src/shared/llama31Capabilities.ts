/**
 * A reference map for the optional Llama 3.1 8B profile in the Skill Tree.
 * These are model capabilities, not executable Mimir skills and not a claim
 * that this computer currently has the model installed.
 */
export interface Llama31Capability {
  name: string;
  description: string;
  grade: string;
}

export const LLAMA31_PROFILE_CATEGORY = "Llama 3.1 8B Profile";

export const LLAMA31_CAPABILITIES: Llama31Capability[] = [
  { name: "structured_writing", description: "Essays, emails, reports, and other structured text.", grade: "A-" },
  { name: "creative_writing", description: "Stories, scripts, dialogue, poetry, and monologues.", grade: "A-" },
  { name: "marketing_copy", description: "Ad copy, social hooks, product descriptions, and SEO drafts.", grade: "A-" },
  { name: "persona_tone", description: "Adapts voice, role, and register for a requested audience.", grade: "A-" },
  { name: "long_summaries", description: "Summarizes supplied long documents and transcripts.", grade: "B+" },
  { name: "data_extraction", description: "Finds names, dates, metrics, and entities in unstructured text.", grade: "B+" },
  { name: "sentiment_tone", description: "Classifies sentiment, urgency, formality, and frustration.", grade: "B+" },
  { name: "classification", description: "Sorts text into requested labels or taxonomies.", grade: "B+" },
  { name: "grammar_editing", description: "Proofreads, clarifies, and changes reading level or style.", grade: "A-" },
  { name: "code_writing", description: "Writes everyday code across common programming languages.", grade: "B+" },
  { name: "sql", description: "Writes and explains SQL queries; review production queries.", grade: "B+" },
  { name: "debugging", description: "Explains supplied errors and proposes targeted fixes.", grade: "B" },
  { name: "code_translation", description: "Converts code between programming languages.", grade: "B" },
  { name: "documentation", description: "Drafts docstrings, comments, and README documentation.", grade: "B+" },
  { name: "math", description: "Works through math and technical problems; verify important results.", grade: "B-" },
  { name: "logical_reasoning", description: "Handles conditional logic, riddles, and design trade-offs.", grade: "B" },
  { name: "data_structuring", description: "Turns notes into Markdown tables, CSV, JSON, or XML.", grade: "B+" },
  { name: "function_calling", description: "Formats calls for tools exposed by the host application.", grade: "B" },
  { name: "structured_json", description: "Produces JSON-shaped output; validate it in software.", grade: "B" },
  { name: "multi_turn_chat", description: "Maintains conversational state when the app manages context well.", grade: "B-" },
  { name: "translation", description: "Translates across Meta's eight supported languages and handles idioms.", grade: "B+" }
];
