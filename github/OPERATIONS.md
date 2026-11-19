# github operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `github.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_authenticated_user` | The user the token belongs to (login, name, plan); a cheap way to check the token |  |
| `list_my_repos` | Repositories the authenticated user can access (owned, collaborator, organization member) | visibility, affiliation, sort, direction, cursor, limit |
| `list_org_repos` | Repositories of an organization | **org**, repo_type, sort, direction, cursor, limit |
| `get_repo` | One repository: description, default branch, visibility, topics, counts | **owner**, **repo** |
| `get_contents` | A file (content base64-encoded in `content`) or a directory listing at a path in the repository; files over 1 MB come without content | **owner**, **repo**, **file_path**, ref |
| `create_or_update_file` | Create or replace one file with a commit (content base64-encoded; pass `sha` of the current file to replace it) | **owner**, **repo**, **file_path**, **message**, **content**, sha, branch |
| `list_issues` | Issues of a repository (pull requests are included too and have a `pull_request` key) | **owner**, **repo**, state, labels, assignee, creator, mentioned, milestone, sort, direction, since, cursor, limit |
| `get_issue` | One issue (or pull request as an issue) with body, labels, assignees and state | **owner**, **repo**, **issue_number** |
| `create_issue` | Open an issue in a repository (as an agent tool only when GITHUB_TOOL_ALLOW_WRITE=1) | **owner**, **repo**, **issue_title**, body, assignees, labels, milestone, issue_type |
| `update_issue` | Change an issue's title, body, state, labels, assignees or milestone (given fields only; labels and assignees are replaced) (as an agent tool only when GITHUB_TOOL_ALLOW_WRITE=1) | **owner**, **repo**, **issue_number**, issue_title, body, state, state_reason, assignees, labels, milestone |
| `list_issue_comments` | Comments on an issue or pull request conversation, oldest first | **owner**, **repo**, **issue_number**, since, cursor, limit |
| `create_issue_comment` | Add a comment to an issue or a pull request conversation (as an agent tool only when GITHUB_TOOL_ALLOW_WRITE=1) | **owner**, **repo**, **issue_number**, **body** |
| `list_pulls` | Pull requests of a repository | **owner**, **repo**, state, head, base, sort, direction, cursor, limit |
| `get_pull` | One pull request: head and base, mergeable state, draft, review requests, counts | **owner**, **repo**, **pull_number** |
| `list_pull_files` | Files changed in a pull request, with status, additions, deletions and patch (up to 3000 files) | **owner**, **repo**, **pull_number**, cursor, limit |
| `create_pull` | Open a pull request from an existing branch (does not push code) (as an agent tool only when GITHUB_TOOL_ALLOW_WRITE=1) | **owner**, **repo**, **pr_title**, **head**, **base**, body, draft, maintainer_can_modify |
| `list_pull_review_comments` | Review comments on the diff of a pull request (line comments) | **owner**, **repo**, **pull_number**, sort, direction, since, cursor, limit |
| `create_pull_review_comment` | Add a review comment on a line of a pull request's diff, or reply to one with in_reply_to (as an agent tool only when GITHUB_TOOL_ALLOW_WRITE=1) | **owner**, **repo**, **pull_number**, **body**, **commit_id**, **path**, line, side, start_line, start_side, in_reply_to, subject_type |
| `merge_pull` | Merge a pull request (pass `sha` to merge only if the head has not moved) | **owner**, **repo**, **pull_number**, merge_method, commit_title, commit_message, sha |
| `search_code` | Search code across GitHub, e.g. q "parseConfig repo:owner/name language:go" (10 requests a minute) | **q**, cursor, limit |
| `search_issues` | Search issues and pull requests, e.g. q "repo:owner/name is:pr is:open review-requested:@me" | **q**, sort, order, advanced_search, cursor, limit |
| `list_releases` | Releases of a repository, newest first (drafts only with push access) | **owner**, **repo**, cursor, limit |
| `get_latest_release` | The latest published, non-prerelease release | **owner**, **repo** |
| `get_release` | One release with notes and assets | **owner**, **repo**, **release_id** |
| `create_release` | Publish a release (creates the tag from target_commitish when it does not exist; may trigger deploy workflows) | **owner**, **repo**, **tag_name**, target_commitish, name, body, draft, prerelease, generate_release_notes, make_latest |
| `delete_release` | Delete a release (the tag stays) | **owner**, **repo**, **release_id** |
| `list_workflow_runs` | GitHub Actions runs of a repository, newest first | **owner**, **repo**, branch, event, status, actor, head_sha, created, cursor, limit |
| `get_workflow_run` | One workflow run: status, conclusion, head commit, timing and links | **owner**, **repo**, **run_id** |
| `rerun_workflow_run` | Re-run every job of a workflow run (uses Actions minutes; rerun_failed_jobs re-runs only failed ones) (as an agent tool only when GITHUB_TOOL_ALLOW_CI=1) | **owner**, **repo**, **run_id**, enable_debug_logging |
| `rerun_failed_jobs` | Re-run only the failed jobs of a workflow run (uses Actions minutes) (as an agent tool only when GITHUB_TOOL_ALLOW_CI=1) | **owner**, **repo**, **run_id**, enable_debug_logging |
| `list_notifications` | Notification threads of the authenticated user (unread only unless all=true); needs a classic token with notifications scope | all, participating, since, before, cursor, limit |
| `mark_notification_read` | Mark one notification thread as read (as an agent tool only when GITHUB_TOOL_ALLOW_WRITE=1) | **thread_id** |
| `api_request` | Call any GitHub REST API endpoint that has no dedicated operation, e.g. path "/repos/octocat/hello-world/branches". Only the API's own host is allowed. | method, **path**, query, body |
