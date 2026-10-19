# BoardUI free-source adaptations

Source: https://github.com/BoardUI/boardui at `ec5c5eb3e29c2441be63b9422cd54f411ef23466`.
License: MIT, retained in LICENSE.txt. No Pro source is included.

- `composer-loader.tsx`: upstream `components/application/composer-loader/composer-loader.tsx`; drawing, sizing and animation retained, utility classes mapped to scoped CSS, localization wrapper removed.
- `agent-composer.tsx`: adapted from the free `components/application/agent-chat/agent-composer.tsx`; retains the pill, circular controls and status-row composition. Uses Aevora's existing icons, multiline input, IME handling, drafts, cancellation and permission checks. Attachment/voice controls call Aevora's existing flows.
- `../../boardui.css`: maps the free App Shell / Sidebar / Agent Chat geometry into the existing React application and the approved blue–cyan theme.

The starter's Next.js routes, AI SDK, browser-history storage, credentials and demo transport are not used. Runtime authority and persistence remain with Aevora's Host/Core.
