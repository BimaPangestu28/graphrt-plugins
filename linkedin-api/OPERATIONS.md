# linkedin-api operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `linkedin-api.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_userinfo` | Read the signed-in member (OpenID userinfo: sub, name, email, picture) and their person_urn. |  |
| `create_post` | Publish a text post as a member or organization, optionally with an uploaded image or an article link. Returns the post URN. | author, **text**, little_text_format, visibility, image_urn, image_alt_text, article_url, article_title, article_description, article_thumbnail_urn, disable_reshare |
| `get_post` | Read one post by URN (as its author). | **post_urn** |
| `list_organization_posts` | List posts by an organization (needs r_organization_social, Community Management API). | author_urn, sort_by, limit, cursor |
| `update_post` | Edit the text of a post. | **post_urn**, **text**, little_text_format |
| `delete_post` | Delete a post. | **post_urn** |
| `upload_image` | Upload an image from a public https URL (image/*, max 10 MB). Returns image_urn for create_post. | **image_url**, owner_urn |
| `list_comments` | List comments on a post, or replies to a comment (pass the comment URN as target_urn). | **target_urn**, limit, cursor |
| `create_comment` | Comment on a post, or reply to a comment with parent_comment_urn. | **target_urn**, **text**, actor, parent_comment_urn |
| `update_comment` | Edit the text of a comment made by the actor. | **target_urn**, **comment_id**, **text**, actor |
| `delete_comment` | Delete a comment (the actor's own, or one on the actor's organization post). | **target_urn**, **comment_id**, actor |
| `add_reaction` | React to a post or comment (LIKE, PRAISE, EMPATHY, INTEREST, APPRECIATION, ENTERTAINMENT). | **target_urn**, reaction_type, actor |
| `remove_reaction` | Remove the actor's reaction from a post or comment. | **target_urn**, actor |
| `list_reactions` | List reactions on a post or comment. | **target_urn**, sort, limit, cursor |
| `api_request` | Call any LinkedIn REST API endpoint that has no dedicated operation, e.g. path "/organizations/12345". Only the API's own host is allowed. | method, **path**, query, body |
