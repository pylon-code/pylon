# Compacting context

Use **Compact context** to shorten an existing supported conversation without clearing the composer draft or its attachments. Pylon submits `/compact` separately. Messages sent while that operation runs are saved in order and sent after compaction completes, with the model and permissions selected for each message.

Stopping or interrupting cancels the unsent queue and leaves a failure message on each affected message. If compaction fails or the server restarts, unsent messages remain visible with an explanation. An interrupted send may already have reached the provider; check the conversation before sending it again.

Prime Agent's native **Compact now** and **Abort compaction** controls retain their own provider status and admission rules. See [Prime Agent](providers-prime-agent.md) for those controls.
