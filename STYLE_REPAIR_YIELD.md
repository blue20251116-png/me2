# Threads style-repair yield optimization

A standalone connector line such as `그리고` followed by a short complete line is a deterministic formatting defect, not a semantic writing problem.

`threadsVoicePolicy.reviewSourceVoice` now merges that connector with the following line locally only when the result remains within the existing 18 Unicode code-point limit. If the merge would exceed the limit, the existing bounded semantic AI repair path remains in place.

Safety behavior is unchanged: high-risk claims still require the existing audit/reject path, the 10-line and 18-code-point hard limits remain, and no generated text is silently truncated or hard-wrapped.
