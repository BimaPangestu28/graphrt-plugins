import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.assemblyai.com";
const GATEWAY = "https://llm-gateway.assemblyai.com";

describeRestPluginContract(pluginDefinition, {
  operations: {
    upload_file: {
      args: { file: "https://files.contract.example/interview.mp3" },
      request: { method: "POST", url: `${API}/v2/upload`, query: "absent", file: { contentType: "application/octet-stream" } },
      response: { body: { upload_url: "https://cdn.assemblyai.com/upload/x" } },
      expect: { data: { upload_url: "https://cdn.assemblyai.com/upload/x" } },
    },
    transcribe: {
      args: { audio_url: "https://assembly.ai/wildfires.mp3", speech_models: ["assemblyai-stt-3-7", "universal-2"], speaker_labels: true, redact_pii: true, redact_pii_policies: ["person_name"] },
      request: {
        method: "POST",
        url: `${API}/v2/transcript`,
        query: "absent",
        json: { audio_url: "https://assembly.ai/wildfires.mp3", speech_models: ["assemblyai-stt-3-7", "universal-2"], speaker_labels: true, redact_pii: true, redact_pii_policies: ["person_name"] },
      },
      response: { body: { status: "queued" } },
    },
    get_transcript: {
      args: { transcript_id: "t-1" },
      request: { method: "GET", url: `${API}/v2/transcript/t-1`, query: "absent" },
      response: { body: { id: "t-1", status: "completed", text: "hello" } },
      expect: { data: { id: "t-1", status: "completed", text: "hello" } },
    },
    list_transcripts: {
      args: { status: "completed", limit: 50 },
      request: { method: "GET", url: `${API}/v2/transcript`, query: { status: "completed", limit: "50" } },
      response: { body: { page_details: { limit: 50, result_count: 1, prev_url: null }, transcripts: [{ id: "t-1" }] } },
      expect: { data: [{ id: "t-1" }] },
    },
    get_sentences: {
      args: { transcript_id: "t-1" },
      request: { method: "GET", url: `${API}/v2/transcript/t-1/sentences`, query: "absent" },
      response: { body: { id: "t-1", sentences: [{ text: "Hello.", start: 0, end: 500 }] } },
      expect: { data: [{ text: "Hello.", start: 0, end: 500 }] },
    },
    get_paragraphs: {
      args: { transcript_id: "t-1" },
      request: { method: "GET", url: `${API}/v2/transcript/t-1/paragraphs`, query: "absent" },
      response: { body: { id: "t-1", paragraphs: [{ text: "Hello there." }] } },
      expect: { data: [{ text: "Hello there." }] },
    },
    get_subtitles: {
      args: { transcript_id: "t-1", subtitle_format: "vtt", chars_per_caption: 32 },
      request: { method: "GET", url: `${API}/v2/transcript/t-1/vtt`, query: { chars_per_caption: "32" } },
    },
    search_words: {
      args: { transcript_id: "t-1", words: ["smoke", "air quality"] },
      request: { method: "GET", url: `${API}/v2/transcript/t-1/word-search`, query: { words: "smoke,air quality" } },
    },
    delete_transcript: {
      args: { transcript_id: "t-1" },
      request: { method: "DELETE", url: `${API}/v2/transcript/t-1`, query: "absent", body: "absent" },
    },
    create_chat_completion: {
      args: { model: "gemini-2.5-flash", messages: [{ role: "user", content: "Summarize: hello" }], max_tokens: 200 },
      request: { method: "POST", url: `${GATEWAY}/v1/chat/completions`, query: "absent", json: { model: "gemini-2.5-flash", messages: [{ role: "user", content: "Summarize: hello" }], max_tokens: 200 } },
    },
    list_llm_models: {
      args: {},
      request: { method: "GET", url: `${GATEWAY}/v1/models`, query: "absent" },
    },
  },
});
