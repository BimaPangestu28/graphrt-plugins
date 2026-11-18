# LinkedIn API research (2026-11-18, docs li-lms-2026-11)
- Base `https://api.linkedin.com/rest`; headers `Linkedin-Version: 202611`, `X-Restli-Protocol-Version: 2.0.0`, Bearer. OIDC `/v2/userinfo` → `sub` → `urn:li:person:{sub}`.
- Tokens 60 days; refresh only for MDP partners.
- Self-serve: `openid profile email`, `w_member_social` (create/delete member posts). `r_member_social` closed.
- Community Management API (approval): `w_organization_social`, `r_organization_social`, `rw_organization_admin`.
- Posts: POST /rest/posts {author, commentary, visibility, distribution{feedDistribution:MAIN_FEED,targetEntities:[],thirdPartyDistributionChannels:[]}, lifecycleState:PUBLISHED, content?{media{id,altText}|article{source,title,description}}} → 201, id in `x-restli-id`.
  GET /rest/posts/{encUrn}?viewContext=AUTHOR; finder GET /rest/posts?q=author&author={encUrn}&count&start&sortBy + `X-RestLi-Method: FINDER`;
  PARTIAL_UPDATE POST /rest/posts/{encUrn} `{"patch":{"$set":{"commentary":..}}}`; DELETE /rest/posts/{encUrn} + `X-RestLi-Method: DELETE`.
- Images: POST /rest/images?action=initializeUpload {initializeUploadRequest:{owner}} → value.uploadUrl, value.image; PUT binary.
- Comments: GET/POST /rest/socialActions/{encPostUrn|encCommentUrn}/comments {actor, object, message{text}, parentComment?}; edit POST .../comments/{id}?actor= PARTIAL_UPDATE {"patch":{"message":{"$set":{"text":..}}}}; DELETE .../comments/{id}?actor=.
- Reactions: POST /rest/reactions?actor={encUrn} {root, reactionType LIKE|PRAISE|EMPATHY|INTEREST|APPRECIATION|ENTERTAINMENT}; DELETE /rest/reactions/(actor:{encUrn},entity:{encUrn}); GET /rest/reactions/(entity:{encUrn})?q=entity.
- Messaging: partners only → out of scope.
- Pagination start/count(≤100), paging.links rel=next. Errors {status, serviceErrorCode, message}. 429 on daily limits, no Retry-After documented.
