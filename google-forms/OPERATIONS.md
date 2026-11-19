# google-forms operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `google-forms.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_form` | A form's title, description, settings, questions (items with questionId) and publish state; responderUri is the link respondents use | **form_id** |
| `create_form` | Create an empty form with a title (add questions with batch_update); it is created in the caller's Drive | **form_title**, document_title, unpublished |
| `batch_update` | Apply batchUpdate requests in order: updateFormInfo, updateSettings, createItem, updateItem, moveItem, deleteItem (as an agent tool only when GOOGLE_FORMS_TOOL_ALLOW_EDIT=1) | **form_id**, **requests**, include_form_in_response, required_revision_id |
| `set_publish_settings` | Set whether the form is published and whether it accepts responses (accepting needs published) (as an agent tool only when GOOGLE_FORMS_TOOL_ALLOW_PUBLISH=1) | **form_id**, **is_published**, **is_accepting_responses** |
| `list_responses` | Submitted responses of a form (answers keyed by questionId; match them with get_form items) | **form_id**, filter, cursor, limit |
| `get_response` | One response by its responseId | **form_id**, **response_id** |
| `list_watches` | Watches the calling Cloud project has on a form | **form_id** |
| `create_watch` | Publish form events (new responses or edits) to a Pub/Sub topic for 7 days; one watch per event type per project | **form_id**, **topic_name**, **event_type**, watch_id |
| `renew_watch` | Extend a watch to 7 days from now | **form_id**, **watch_id** |
| `delete_watch` | Delete a watch | **form_id**, **watch_id** |
| `api_request` | Call any Google Forms API endpoint that has no dedicated operation, e.g. path "/forms/<id>". Only the API's own host is allowed. | method, **path**, query, body |
