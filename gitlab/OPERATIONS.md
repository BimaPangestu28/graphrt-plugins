# gitlab operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `gitlab.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_current_user` | The user the token belongs to; a cheap way to check the token |  |
| `list_projects` | Projects visible to the token (member projects by default) | membership, search, owned, starred, archived, visibility, order_by, sort, simple, cursor, limit |
| `get_project` | One project: default branch, visibility, URLs, statistics | **project_id** |
| `list_issues` | Issues of a project | **project_id**, state, labels, search, assignee_username, author_username, milestone, updated_after, order_by, sort, cursor, limit |
| `get_issue` | One issue with description, labels, assignees and state | **project_id**, **issue_iid** |
| `create_issue` | Open an issue in a project (as an agent tool only when GITLAB_TOOL_ALLOW_WRITE=1) | **project_id**, **issue_title**, description, labels, assignee_ids, milestone_id, due_date, confidential |
| `update_issue` | Change an issue: title, description, labels, assignees, due date, or close/reopen with state_event (as an agent tool only when GITLAB_TOOL_ALLOW_WRITE=1) | **project_id**, **issue_iid**, issue_title, description, state_event, labels, add_labels, remove_labels, assignee_ids, milestone_id, due_date |
| `delete_issue` | Delete an issue permanently (project owners and admins only) | **project_id**, **issue_iid** |
| `list_issue_notes` | Comments (notes) on an issue, including system notes | **project_id**, **issue_iid**, sort, order_by, cursor, limit |
| `create_issue_note` | Add a comment (note) to an issue (as an agent tool only when GITLAB_TOOL_ALLOW_WRITE=1) | **project_id**, **issue_iid**, **body**, internal |
| `list_merge_requests` | Merge requests of a project | **project_id**, state, source_branch, target_branch, labels, search, author_username, reviewer_username, order_by, sort, cursor, limit |
| `get_merge_request` | One merge request: branches, state, merge status, pipeline, approvals summary | **project_id**, **merge_request_iid** |
| `list_merge_request_diffs` | Changed files of a merge request with their diffs | **project_id**, **merge_request_iid**, cursor, limit |
| `create_merge_request` | Open a merge request from an existing branch (does not push code; prefix the title with "Draft:" for a draft) (as an agent tool only when GITLAB_TOOL_ALLOW_WRITE=1) | **project_id**, **source_branch**, **target_branch**, **mr_title**, description, labels, assignee_ids, reviewer_ids, remove_source_branch, squash |
| `list_merge_request_notes` | Comments (notes) on a merge request | **project_id**, **merge_request_iid**, sort, cursor, limit |
| `create_merge_request_note` | Add a comment (note) to a merge request (as an agent tool only when GITLAB_TOOL_ALLOW_WRITE=1) | **project_id**, **merge_request_iid**, **body** |
| `merge_merge_request` | Merge a merge request (pass `sha` to merge only if the head has not moved) | **project_id**, **merge_request_iid**, sha, squash, should_remove_source_branch, merge_commit_message, auto_merge |
| `list_pipelines` | CI/CD pipelines of a project, newest first | **project_id**, status, ref, sha, source, updated_after, order_by, sort, cursor, limit |
| `get_pipeline` | One pipeline: status, ref, sha, duration, coverage | **project_id**, **pipeline_id** |
| `list_pipeline_jobs` | Jobs of a pipeline with stage, status and failure reason | **project_id**, **pipeline_id**, scope, cursor, limit |
| `retry_pipeline` | Retry the failed or canceled jobs of a pipeline (uses CI minutes) (as an agent tool only when GITLAB_TOOL_ALLOW_CI=1) | **project_id**, **pipeline_id** |
| `cancel_pipeline` | Cancel the running jobs of a pipeline (as an agent tool only when GITLAB_TOOL_ALLOW_CI=1) | **project_id**, **pipeline_id** |
| `create_pipeline` | Start a new pipeline for a branch or tag (may deploy) | **project_id**, **ref**, variables |
| `get_file` | A file at a ref: metadata plus content (base64 in `content`) | **project_id**, **file_path**, **ref** |
| `list_repository_tree` | Files and directories at a path and ref | **project_id**, path, ref, recursive, cursor, limit |
| `create_file` | Create a file with a commit | **project_id**, **file_path**, **branch**, **content**, **commit_message**, encoding, start_branch |
| `update_file` | Replace a file's content with a commit (pass last_commit_id to refuse if it changed meanwhile) | **project_id**, **file_path**, **branch**, **content**, **commit_message**, encoding, start_branch, last_commit_id |
| `api_request` | Call any GitLab REST API endpoint that has no dedicated operation, e.g. path "/projects/group%2Fproject/repository/branches". Only the API's own host is allowed. | method, **path**, query, body |
