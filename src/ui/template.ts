/**
 * Brutalist Web UI for Outie Memories
 *
 * Raw, functional, dense information display
 * Black & white, monospace, bold borders
 */

export function generateHTML(data: {
  conversation: Array<{ id: string; role: string; content: string; timestamp: number; trigger: string; source?: string }>;
  journal: Array<{ id: string; timestamp: number; topic: string; content: string }>;
  stateFiles: Record<string, string>;
  reminders: Array<{ id: string; description: string; payload: string; cronExpression?: string; scheduledTime?: number; createdAt: number }>;
  summaries: Array<{ id: string; timestamp: number; summary: string; notes?: string; keyDecisions?: string[]; openThreads?: string[]; learnedPatterns?: string[] }>;
  topics: Array<{ id: string; name: string; content: string; createdAt: number; updatedAt: number }>;
  stats: { messageCount: number; estimatedTokens: number; needsCompaction: boolean };
  sessionStatus: { sessionId: string | null; isProcessing: boolean };
}): string {
  const formatDate = (ts: number) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  const escapeHtml = (str: string) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OUTIE // MEMORY SYSTEM</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Courier New', Courier, monospace;
      background: #fff;
      color: #000;
      line-height: 1.4;
      padding: 20px;
    }

    header {
      border: 4px solid #000;
      padding: 20px;
      margin-bottom: 20px;
      background: #000;
      color: #fff;
    }

    h1 {
      font-size: 32px;
      font-weight: bold;
      letter-spacing: 2px;
    }

    .stats {
      margin-top: 10px;
      font-size: 14px;
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
    }

    .stats span {
      border-left: 2px solid #fff;
      padding-left: 10px;
    }

    .stats span:first-child {
      border-left: none;
      padding-left: 0;
    }

    .session-status {
      margin-top: 10px;
      padding: 10px;
      border: 2px solid #fff;
      background: ${data.sessionStatus.isProcessing ? '#fff' : '#000'};
      color: ${data.sessionStatus.isProcessing ? '#000' : '#fff'};
      font-weight: bold;
    }

    .session-status a {
      color: inherit;
      text-decoration: underline;
      text-decoration-thickness: 2px;
    }

    .session-status a:hover {
      background: ${data.sessionStatus.isProcessing ? '#000' : '#fff'};
      color: ${data.sessionStatus.isProcessing ? '#fff' : '#000'};
    }

    .container {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 20px;
    }

    .block {
      border: 4px solid #000;
      background: #fff;
    }

    .block-header {
      background: #000;
      color: #fff;
      padding: 10px;
      font-weight: bold;
      font-size: 18px;
      letter-spacing: 1px;
    }

    .block-content {
      padding: 15px;
      max-height: 600px;
      overflow-y: auto;
    }

    .block.full {
      grid-column: span 2;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }

    table:first-child {
      margin-top: 0;
    }

    th, td {
      border: 2px solid #000;
      padding: 8px;
      text-align: left;
      vertical-align: top;
    }

    th {
      background: #000;
      color: #fff;
      font-weight: bold;
    }

    tr:nth-child(even) {
      background: #f0f0f0;
    }

    .message {
      border: 2px solid #000;
      margin-bottom: 10px;
      padding: 10px;
    }

    .message-header {
      font-weight: bold;
      margin-bottom: 5px;
      padding-bottom: 5px;
      border-bottom: 1px solid #000;
    }

    .message.user {
      background: #f0f0f0;
    }

    .message.assistant {
      background: #fff;
      border-width: 3px;
    }

    .entry {
      border: 2px solid #000;
      padding: 10px;
      margin-bottom: 10px;
    }

    .entry-header {
      font-weight: bold;
      border-bottom: 1px solid #000;
      padding-bottom: 5px;
      margin-bottom: 5px;
    }

    .state-file {
      border: 2px solid #000;
      padding: 10px;
      margin-bottom: 10px;
    }

    .state-file-name {
      font-weight: bold;
      background: #000;
      color: #fff;
      padding: 5px;
      margin: -10px -10px 10px -10px;
    }

    pre {
      white-space: pre-wrap;
      word-wrap: break-word;
      font-family: 'Courier New', Courier, monospace;
      font-size: 13px;
    }

    .empty {
      color: #666;
      font-style: italic;
      text-align: center;
      padding: 40px;
    }

    .refresh {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #000;
      color: #fff;
      border: 4px solid #000;
      padding: 15px 30px;
      font-family: 'Courier New', Courier, monospace;
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
    }

    .refresh:hover {
      background: #fff;
      color: #000;
    }

    .timestamp {
      color: #666;
      font-size: 12px;
    }

    .badge {
      display: inline-block;
      background: #000;
      color: #fff;
      padding: 2px 6px;
      font-size: 11px;
      font-weight: bold;
      margin-left: 5px;
    }

    .warning {
      background: #000;
      color: #fff;
      padding: 5px;
      font-weight: bold;
    }

    /* Responsive Design */
    @media (max-width: 1024px) {
      .container {
        grid-template-columns: 1fr;
      }

      .block.full {
        grid-column: span 1;
      }

      h1 {
        font-size: 24px;
      }

      .stats {
        font-size: 12px;
        gap: 10px;
      }
    }

    @media (max-width: 768px) {
      body {
        padding: 10px;
      }

      header {
        padding: 15px;
        border-width: 3px;
      }

      h1 {
        font-size: 20px;
        letter-spacing: 1px;
      }

      .stats {
        font-size: 11px;
        gap: 8px;
      }

      .stats span {
        border-left: none;
        padding-left: 0;
      }

      .container {
        gap: 10px;
      }

      .block {
        border-width: 3px;
      }

      .block-header {
        font-size: 16px;
        padding: 8px;
      }

      .block-content {
        padding: 10px;
        max-height: 400px;
      }

      .message, .entry, .state-file {
        border-width: 2px;
        padding: 8px;
        margin-bottom: 8px;
      }

      th, td {
        padding: 6px;
        font-size: 12px;
      }

      .refresh {
        padding: 10px 20px;
        font-size: 14px;
        bottom: 10px;
        right: 10px;
        border-width: 3px;
      }

      pre {
        font-size: 12px;
      }

      .timestamp {
        font-size: 11px;
      }

      .badge {
        font-size: 10px;
        padding: 2px 4px;
      }
    }

    @media (max-width: 480px) {
      body {
        padding: 5px;
      }

      header {
        padding: 10px;
        border-width: 2px;
      }

      h1 {
        font-size: 16px;
        letter-spacing: 0.5px;
      }

      .stats {
        font-size: 10px;
        gap: 5px;
        flex-direction: column;
      }

      .session-status {
        font-size: 11px;
        padding: 8px;
      }

      .block-header {
        font-size: 14px;
        padding: 6px;
      }

      .block-content {
        padding: 8px;
        max-height: 300px;
      }

      .message-header, .entry-header {
        font-size: 11px;
      }

      pre {
        font-size: 11px;
      }

      .refresh {
        padding: 8px 15px;
        font-size: 12px;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>OUTIE // MEMORY SYSTEM</h1>
    <div class="stats">
      <span>MESSAGES: ${data.stats.messageCount}</span>
      <span>TOKENS: ${data.stats.estimatedTokens}</span>
      <span>JOURNAL: ${data.journal.length}</span>
      <span>TOPICS: ${data.topics.length}</span>
      <span>REMINDERS: ${data.reminders.length}</span>
      ${data.stats.needsCompaction ? '<span class="warning">COMPACTION NEEDED</span>' : ''}
    </div>
    <div class="session-status">
      ${data.sessionStatus.isProcessing ? '● PROCESSING' : '○ IDLE'}
      ${data.sessionStatus.sessionId ? `// SESSION: <a href="/?session=${data.sessionStatus.sessionId}" target="_blank">${data.sessionStatus.sessionId.slice(0, 8)}</a>` : '// NO ACTIVE SESSION'}
    </div>
  </header>

  <div class="container">
    <!-- Conversation -->
    <div class="block full">
      <div class="block-header">CONVERSATION BUFFER [${data.conversation.length}]</div>
      <div class="block-content">
        ${data.conversation.length === 0 ? '<div class="empty">NO MESSAGES</div>' : ''}
        ${data.conversation.map(msg => `
          <div class="message ${msg.role}">
            <div class="message-header">
              ${msg.role.toUpperCase()}
              <span class="badge">${msg.trigger}</span>
              ${msg.source ? `<span class="badge">${msg.source}</span>` : ''}
              <span class="timestamp">${formatDate(msg.timestamp)}</span>
            </div>
            <pre>${escapeHtml(msg.content)}</pre>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Journal -->
    <div class="block">
      <div class="block-header">JOURNAL [${data.journal.length}]</div>
      <div class="block-content">
        ${data.journal.length === 0 ? '<div class="empty">NO ENTRIES</div>' : ''}
        ${data.journal.slice().reverse().map(entry => `
          <div class="entry">
            <div class="entry-header">
              ${escapeHtml(entry.topic)}
              <span class="timestamp">${formatDate(entry.timestamp)}</span>
            </div>
            <pre>${escapeHtml(entry.content)}</pre>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Topics -->
    <div class="block">
      <div class="block-header">TOPICS [${data.topics.length}]</div>
      <div class="block-content">
        ${data.topics.length === 0 ? '<div class="empty">NO TOPICS</div>' : ''}
        ${data.topics.map(topic => `
          <div class="entry">
            <div class="entry-header">
              ${escapeHtml(topic.name)}
              <span class="timestamp">
                Created: ${formatDate(topic.createdAt)} //
                Updated: ${formatDate(topic.updatedAt)}
              </span>
            </div>
            <pre>${escapeHtml(topic.content)}</pre>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- State Files -->
    <div class="block">
      <div class="block-header">STATE FILES [${Object.keys(data.stateFiles).length}]</div>
      <div class="block-content">
        ${Object.keys(data.stateFiles).length === 0 ? '<div class="empty">NO STATE FILES</div>' : ''}
        ${Object.entries(data.stateFiles).map(([name, content]) => `
          <div class="state-file">
            <div class="state-file-name">${escapeHtml(name)}</div>
            <pre>${escapeHtml(content)}</pre>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Reminders -->
    <div class="block">
      <div class="block-header">REMINDERS [${data.reminders.length}]</div>
      <div class="block-content">
        ${data.reminders.length === 0 ? '<div class="empty">NO REMINDERS</div>' : ''}
        <table>
          ${data.reminders.length > 0 ? `
            <thead>
              <tr>
                <th>ID</th>
                <th>DESCRIPTION</th>
                <th>SCHEDULE</th>
                <th>PAYLOAD</th>
              </tr>
            </thead>
          ` : ''}
          <tbody>
            ${data.reminders.map(rem => `
              <tr>
                <td>${escapeHtml(rem.id)}</td>
                <td>${escapeHtml(rem.description)}</td>
                <td>
                  ${rem.cronExpression ? `CRON: ${escapeHtml(rem.cronExpression)}` : ''}
                  ${rem.scheduledTime ? `ONCE: ${formatDate(rem.scheduledTime)}` : ''}
                </td>
                <td><pre>${escapeHtml(rem.payload)}</pre></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Summaries -->
    <div class="block full">
      <div class="block-header">CONVERSATION SUMMARIES [${data.summaries.length}]</div>
      <div class="block-content">
        ${data.summaries.length === 0 ? '<div class="empty">NO SUMMARIES</div>' : ''}
        ${data.summaries.map(summary => `
          <div class="entry">
            <div class="entry-header">
              SUMMARY
              <span class="timestamp">${formatDate(summary.timestamp)}</span>
            </div>
            <pre>${escapeHtml(summary.summary)}</pre>
            ${summary.notes ? `<div style="margin-top: 10px; border-top: 1px solid #000; padding-top: 10px;"><strong>NOTES:</strong><br><pre>${escapeHtml(summary.notes)}</pre></div>` : ''}
            ${summary.keyDecisions && summary.keyDecisions.length > 0 ? `
              <div style="margin-top: 10px; border-top: 1px solid #000; padding-top: 10px;">
                <strong>KEY DECISIONS:</strong>
                <ul>
                  ${summary.keyDecisions.map(d => `<li>${escapeHtml(d)}</li>`).join('')}
                </ul>
              </div>
            ` : ''}
            ${summary.openThreads && summary.openThreads.length > 0 ? `
              <div style="margin-top: 10px; border-top: 1px solid #000; padding-top: 10px;">
                <strong>OPEN THREADS:</strong>
                <ul>
                  ${summary.openThreads.map(t => `<li>${escapeHtml(t)}</li>`).join('')}
                </ul>
              </div>
            ` : ''}
            ${summary.learnedPatterns && summary.learnedPatterns.length > 0 ? `
              <div style="margin-top: 10px; border-top: 1px solid #000; padding-top: 10px;">
                <strong>LEARNED PATTERNS:</strong>
                <ul>
                  ${summary.learnedPatterns.map(p => `<li>${escapeHtml(p)}</li>`).join('')}
                </ul>
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  </div>

  <button class="refresh" onclick="location.reload()">↻ REFRESH</button>

  <script>
    // Auto-refresh every 10 seconds
    setTimeout(() => location.reload(), 10000);
  </script>
</body>
</html>`;
}
