// Shared server-rendered UI; no external fonts, scripts, or styles are required.
export const styles = `
:root {
  color-scheme: light;
  --paper: #faf8f4;
  --surface: #fff;
  --ink: #292925;
  --muted: #6b6a63;
  --line: #e6e3dc;
  --coral: #c44735;
  --coral-soft: #fbede7;
  --green: #34634e;
  --green-soft: #eaf2ec;
  --amber: #805c24;
  --amber-soft: #faf0d9;
  --radius: 16px;
  --mono: ui-monospace, SFMono-Regular, Consolas, monospace;
}
* {
  box-sizing: border-box;
}
html {
  scroll-padding-top: 32px;
}
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font:
    15px/1.6 -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  -webkit-font-smoothing: antialiased;
}
a {
  color: var(--coral);
  text-underline-offset: 4px;
}
button,
input {
  font: inherit;
}
button,
a,
input,
summary {
  -webkit-tap-highlight-color: transparent;
}
:focus-visible {
  outline: 3px solid var(--coral);
  outline-offset: 4px;
}
h1,
h2,
h3,
h4,
p {
  margin: 0;
}
h1,
h2,
h3,
h4 {
  line-height: 1.2;
  letter-spacing: -0.025em;
}
h1 {
  text-wrap: balance;
  font-size: 36px;
  font-weight: 650;
}
h2 {
  font-size: 23px;
  font-weight: 650;
}
h3 {
  font-size: 17px;
  font-weight: 650;
}
h4 {
  font-size: 15px;
  font-weight: 600;
}
p + p {
  margin-top: 12px;
}
small,
.muted {
  color: var(--muted);
  font-size: 13px;
}
code,
pre {
  font-family: var(--mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
pre {
  margin: 0;
  white-space: pre-wrap;
}
button,
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 10px 17px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--coral);
  color: white;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
  transition: background 0.15s;
}
button:hover,
.button:hover {
  background: #a93727;
}
button.secondary,
.button.secondary {
  background: var(--surface);
  border-color: var(--line);
  color: var(--ink);
}
button.secondary:hover,
.button.secondary:hover {
  background: var(--paper);
}
button.danger {
  background: transparent;
  border-color: #ebd6cf;
  color: #a63b2c;
}
button.danger:hover {
  background: var(--coral-soft);
}
button.quiet,
.button.quiet {
  background: transparent;
  color: var(--muted);
  border-color: var(--line);
}
button.quiet:hover,
.button.quiet:hover {
  background: #eeece6;
  color: var(--ink);
}
form {
  margin: 0;
}
.full {
  width: 100%;
}
.actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.actions > form {
  flex: 1;
}
.actions button {
  width: 100%;
}
.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
}
.lead {
  color: var(--muted);
  margin-top: 12px;
  max-width: 58ch;
  font-size: 15px;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--ink);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.04em;
  text-decoration: none;
}
.brand img {
  width: 44px;
  height: 44px;
  object-fit: contain;
}
.skip {
  position: fixed;
  top: -100px;
  left: 16px;
  z-index: 20;
  background: var(--ink);
  color: white;
  padding: 10px 18px;
}
.skip:focus {
  top: 12px;
}
.topbar {
  border-top: 3px solid var(--coral);
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}
.topbar-inner {
  max-width: 1240px;
  margin: auto;
  min-height: 82px;
  padding: 16px 32px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
}
.topbar-context {
  display: flex;
  align-items: center;
  gap: 22px;
  min-width: 0;
}
.topbar-context .eyebrow {
  border-left: 1px solid var(--line);
  padding-left: 22px;
}
.shell {
  max-width: 1240px;
  margin: auto;
  padding: 42px 32px 64px;
  display: grid;
  grid-template-columns: 185px minmax(0, 1fr);
  gap: 42px;
}
.sidebar {
  align-self: start;
  position: sticky;
  top: 30px;
}
.sidebar nav {
  display: grid;
  gap: 6px;
  margin-top: 16px;
}
.sidebar nav a {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  color: var(--muted);
  text-decoration: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 550;
}
.sidebar nav a:hover {
  background: #eeece6;
  color: var(--ink);
}
.nav-count {
  border: 1px solid var(--line);
  border-radius: 6px;
  min-width: 24px;
  text-align: center;
  font: 11px/20px var(--mono);
}
.sidebar-note {
  overflow-wrap: anywhere;
  border-top: 1px solid var(--line);
  margin-top: 30px;
  padding: 20px 12px;
  font-size: 12px;
  color: var(--muted);
}
main {
  min-width: 0;
}
.page-heading {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 28px;
}
.page-heading .eyebrow {
  margin-bottom: 10px;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin: 26px 0;
}
.metric {
  padding: 20px 22px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  text-decoration: none;
  color: var(--ink);
}
.metric-label {
  font-size: 12px;
  color: var(--muted);
}
.metric-value {
  display: block;
  font-size: 32px;
  font-weight: 600;
  letter-spacing: -0.04em;
  line-height: 1.25;
  margin: 7px 0;
}
.metric-note {
  font-size: 12px;
  color: var(--muted);
}
.metric.attention {
  background: var(--coral-soft);
  border-color: #edd0c4;
}
.metric.attention .metric-value {
  color: var(--coral);
}
.endpoint {
  display: flex;
  gap: 24px;
  align-items: center;
  justify-content: space-between;
  padding: 18px 22px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #f1efe9;
}
.endpoint label {
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
}
.endpoint input {
  padding: 8px 10px;
  width: 100%;
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 6px;
  font: 12px/1.5 var(--mono);
  color: var(--ink);
}
.section {
  margin-top: 40px;
  scroll-margin-top: 28px;
}
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 17px;
}
.section-heading p {
  margin-top: 7px;
  font-size: 13px;
  color: var(--muted);
}
.section-number {
  font: 11px var(--mono);
  color: var(--muted);
  margin-bottom: 8px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
}
.card + .card {
  margin-top: 14px;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 22px 24px;
  flex-wrap: wrap;
}
.card-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex-wrap: wrap;
}
.card-title h3,
.card-title h4 {
  overflow-wrap: anywhere;
}
.card-header small {
  display: block;
  margin-top: 6px;
}
.card-body {
  padding: 0 24px 24px;
}
.card-footer {
  padding: 16px 24px;
  border-top: 1px solid var(--line);
  background: #fdfcf9;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.card-footer small {
  max-width: 56ch;
}
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 5px;
  background: #f0eee8;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.6;
  white-space: nowrap;
}
.badge.good {
  background: var(--green-soft);
  color: var(--green);
}
.badge.warn {
  background: var(--amber-soft);
  color: var(--amber);
}
.badge.off {
  color: var(--muted);
}
.badge.danger {
  background: var(--coral-soft);
  color: #a63b2c;
}
.connection-dot {
  width: 6px;
  height: 6px;
  background: currentColor;
  border-radius: 50%;
}
.instance {
  padding: 20px 24px;
  border-top: 1px solid var(--line);
}
.instance-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
}
.instance-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 7px;
}
.runtime {
  font: 11px/1.6 var(--mono);
  color: var(--muted);
}
.context {
  font-size: 13px;
  color: var(--muted);
  margin-top: 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.disclosure {
  margin-top: 14px;
}
.disclosure summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--muted);
  padding: 4px 0;
  width: fit-content;
}
.disclosure[open] summary {
  margin-bottom: 12px;
}
.data {
  display: grid;
  grid-template-columns: minmax(100px, 140px) minmax(0, 1fr);
  gap: 8px 16px;
  margin: 0;
  font-size: 12px;
}
.data dt {
  overflow-wrap: anywhere;
  color: var(--muted);
}
.data dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.data dd pre {
  background: var(--paper);
  padding: 12px;
  border-radius: 8px;
}
.fingerprint {
  padding: 14px 16px;
  margin-top: 10px;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 8px;
  word-break: break-all;
  line-height: 1.8;
  user-select: all;
}
.pairing-intro {
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--muted);
}
.pairing .instance {
  padding-right: 0;
  padding-left: 0;
}
.pairing .instance:last-child {
  padding-bottom: 0;
}
.notice {
  padding: 16px 18px;
  background: var(--coral-soft);
  border: 1px solid #efd5ca;
  border-radius: 10px;
  font-size: 13px;
  color: #794739;
}
.notice p {
  margin-top: 7px;
}
.notice strong {
  font-weight: 650;
}
.notice.error {
  color: #943b2b;
}
.notice.success {
  background: var(--green-soft);
  border-color: #cfded4;
  color: var(--green);
}
.empty {
  border: 1px dashed #d9d6ce;
  border-radius: var(--radius);
  padding: 30px 24px;
  background: #fdfcf9;
}
.empty h3 {
  font-size: 15px;
  margin-bottom: 8px;
}
.empty p {
  font-size: 13px;
  color: var(--muted);
  max-width: 65ch;
}
.empty a {
  display: inline-block;
  margin-top: 14px;
  font-size: 13px;
}
.policy {
  margin-top: 34px;
  padding-top: 22px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--muted);
}
.policy summary {
  cursor: pointer;
  width: fit-content;
}
.policy p {
  margin-top: 10px;
  max-width: 90ch;
}
.history {
  margin-top: 18px;
}
.history > summary {
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  padding: 12px 0;
}
.history[open] > summary {
  margin-bottom: 10px;
}
.site-footer {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--muted);
  margin-top: 40px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
}
.site-footer a {
  color: var(--muted);
}
.focus-shell {
  max-width: 1140px;
  margin: auto;
  padding: 64px 40px 40px;
}
.focus-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 460px);
  gap: 80px;
  align-items: center;
  min-height: calc(100vh - 230px);
}
.focus-intro {
  padding: 30px 0;
}
.focus-intro h1 {
  font-size: 48px;
  line-height: 1.12;
  letter-spacing: -0.05em;
  max-width: 10ch;
  margin: 20px 0;
}
.focus-intro .lead {
  max-width: 32ch;
  font-size: 16px;
}
.focus-intro .eyebrow {
  color: var(--coral);
}
.intro-foot {
  margin-top: 40px;
  max-width: 32ch;
  font-size: 12px;
  color: var(--muted);
  padding-top: 20px;
  border-top: 1px solid var(--line);
}
.focus-card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 20px;
  padding: 34px;
  box-shadow: 0 12px 40px #40312106;
  min-width: 0;
}
.focus-card h2 {
  font-size: 26px;
}
.focus-card .lead {
  font-size: 14px;
  margin-bottom: 25px;
}
.instance-origin {
  display: block;
  margin: 22px 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--paper);
  font: 12px/1.6 var(--mono);
  overflow-wrap: anywhere;
}
.field {
  margin: 22px 0;
}
.field label {
  display: block;
  font-size: 13px;
  font-weight: 650;
  margin-bottom: 9px;
}
.field input {
  width: 100%;
  min-height: 48px;
  border: 1px solid #cbc8bf;
  border-radius: 8px;
  padding: 11px 13px;
  background: var(--surface);
  color: var(--ink);
}
.field input[aria-invalid="true"] {
  border-color: var(--coral);
}
.field small {
  display: block;
  margin-top: 9px;
  font-size: 12px;
}
.focus-card .notice {
  margin: 20px 0;
}
.form-foot {
  font-size: 12px;
  color: var(--muted);
  margin-top: 20px;
}
.consent-client {
  padding: 18px 0 22px;
  margin-top: 8px;
  border-bottom: 1px solid var(--line);
}
.consent-client h3 {
  font-size: 21px;
  margin: 8px 0;
  overflow-wrap: anywhere;
}
.consent-client code {
  color: var(--muted);
}
.permissions {
  padding-left: 20px;
  margin: 20px 0;
  font-size: 13px;
}
.permissions li {
  margin: 10px 0;
  padding-left: 4px;
}
.permissions li::marker {
  color: var(--coral);
}
.result-card {
  max-width: 560px;
  margin: 60px auto 100px;
  padding: 40px;
}
.result-card h1 {
  font-size: 30px;
  margin: 12px 0 18px;
}
.result-card .actions {
  margin-top: 26px;
}
.result-code {
  font: 12px var(--mono);
  color: var(--coral);
}
.result-card .lead {
  font-size: 14px;
}
.approval-policy {
  margin-bottom: 18px;
}
.flash {
  margin-bottom: 24px;
}
.grant-row {
  padding: 22px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}
.grant-row + .grant-row {
  border-top: 1px solid var(--line);
}
.grant-info {
  min-width: 0;
  flex: 1;
}
.grant-info code {
  display: block;
  margin: 8px 0;
  overflow-wrap: anywhere;
}
.grant-info small {
  display: block;
}
.grant-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.pending-scope {
  margin: 12px 0;
}
.pending-scope > .data {
  padding: 14px;
  background: var(--paper);
  border-radius: 8px;
}
@media (min-width: 1400px) {
  .focus-layout {
    gap: 120px;
  }
  .focus-intro h1 {
    font-size: 54px;
  }
}
@media (max-width: 900px) {
  .shell {
    grid-template-columns: 1fr;
    gap: 26px;
    padding: 28px 24px 48px;
  }
  .sidebar {
    position: static;
  }
  .sidebar > .eyebrow,
  .sidebar-note {
  overflow-wrap: anywhere;
    display: none;
  }
  .sidebar nav {
    display: flex;
    gap: 6px;
    margin: 0;
    flex-wrap: wrap;
  }
  .sidebar nav a {
    background: #eeece6;
    flex: 1;
    justify-content: center;
  }
  .focus-layout {
    gap: 36px;
    grid-template-columns: minmax(0, 1fr) minmax(0, 420px);
  }
  .focus-intro h1 {
    font-size: 38px;
  }
  .focus-shell {
    padding: 36px 28px;
  }
  .topbar-inner {
    padding: 14px 24px;
  }
}
@media (max-width: 640px) {
  h1 {
    font-size: 29px;
  }
  .topbar-inner {
    min-height: 72px;
    padding: 12px 20px;
  }
  .topbar-context .eyebrow {
    display: none;
  }
  .shell {
    padding: 20px 18px 36px;
  }
  .sidebar nav a {
    padding: 10px 8px;
    font-size: 12px;
  }
  .sidebar .nav-count {
    display: none;
  }
  .page-heading {
    margin-bottom: 20px;
  }
  .page-heading > .button {
    padding: 9px 12px;
  }
  .metrics {
    gap: 8px;
    margin: 20px 0;
  }
  .metric {
    padding: 14px 12px;
    border-radius: 10px;
  }
  .metric-value {
    font-size: 27px;
  }
  .metric-label,
  .metric-note {
    font-size: 11px;
  }
  .endpoint {
    display: block;
    padding: 16px;
  }
  .endpoint input {
    margin-top: 8px;
  }
  .section {
    margin-top: 30px;
  }
  .card-header {
    padding: 18px;
  }
  .card-body {
    padding: 0 18px 18px;
  }
  .instance {
    padding: 18px;
  }
  .card-footer {
    padding: 16px 18px;
    align-items: stretch;
    flex-direction: column;
  }
  .card-footer button {
    width: 100%;
  }
  .data {
    grid-template-columns: 1fr;
    gap: 4px;
  }
  .data dd + dt {
    margin-top: 10px;
  }
  .focus-shell {
    padding: 22px 20px;
  }
  .focus-layout {
    display: block;
    min-height: 0;
  }
  .focus-intro {
    padding: 20px 0 28px;
  }
  .focus-intro h1 {
    font-size: 32px;
    max-width: none;
    margin: 12px 0;
  }
  .focus-intro .lead {
    font-size: 14px;
    max-width: none;
  }
  .intro-foot {
    display: none;
  }
  .focus-card {
    padding: 24px;
    border-radius: 14px;
  }
  .focus-card h2 {
    font-size: 23px;
  }
  .focus-shell .site-footer {
    margin-top: 30px;
  }
  .result-card {
    margin: 30px auto 60px;
    padding: 28px;
  }
  .grant-row {
    padding: 18px;
  }
  .grant-row > form {
    width: 100%;
  }
  .grant-row button {
    width: 100%;
  }
  .section-heading p {
    max-width: 44ch;
  }
  .instance-heading > form {
    width: 100%;
  }
  .instance-heading > form button {
    width: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  * {
    transition: none !important;
    scroll-behavior: auto !important;
  }
}
`;
