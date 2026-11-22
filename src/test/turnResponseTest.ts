import { extractTextContent, TrueForgeConnection } from '../connection/TrueForgeConnection.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${testName} - ${detail ?? 'Assertion failed'}`);
    failed++;
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('  TRUEFORGE TURN RESPONSE & ERROR HANDLING TESTS');
  console.log('====================================================\n');

  // -----------------------------------------------------------------
  // SUITE 1: Array-Based and Part-Based Text Extraction
  // -----------------------------------------------------------------
  console.log('--- Suite 1: Text Content Extraction ---');

  // 1.1 Plain string extraction
  const strResult = extractTextContent('Hello TrueForge');
  assert(strResult === 'Hello TrueForge', 'Extracts direct string content');

  // 1.2 Array of text parts
  const arrayResult = extractTextContent([
    { type: 'text', text: 'Step 1: Inspect. ' },
    { type: 'text', text: 'Step 2: Propose.' }
  ]);
  assert(
    arrayResult === 'Step 1: Inspect. Step 2: Propose.',
    'Extracts and joins array of text parts'
  );

  // 1.3 Refusal content part
  const refusalResult = extractTextContent([
    { type: 'refusal', refusal: 'Cannot fulfill this request safely.' }
  ]);
  assert(
    refusalResult === 'Cannot fulfill this request safely.',
    'Extracts refusal part correctly'
  );

  // 1.4 Single object with text
  const singleObjResult = extractTextContent({ type: 'text', text: 'Single object text' });
  assert(singleObjResult === 'Single object text', 'Extracts single object text');

  // 1.5 Null, undefined, empty array, empty object handling
  assert(extractTextContent(null) === '', 'Handles null gracefully');
  assert(extractTextContent(undefined) === '', 'Handles undefined gracefully');
  assert(extractTextContent([]) === '', 'Handles empty array gracefully');
  assert(extractTextContent({}) === '', 'Handles empty object gracefully');

  // -----------------------------------------------------------------
  // SUITE 2: Gemini & Provider Error Propagation
  // -----------------------------------------------------------------
  console.log('\n--- Suite 2: Provider Error Propagation ---');

  const errorConnection = new TrueForgeConnection();
  const mockErrorMessage = '[Model Error] Request failed (503): Resource has been exhausted (e.g. check quota)';

  // Mock createTurnStream to yield turn.done with error state
  (errorConnection.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'turn.done',
      id: 'evt_err_1',
      createdAt: new Date().toISOString(),
      threadId: null,
      state: {
        status: 'error',
        message: mockErrorMessage,
        completedAt: new Date().toISOString()
      }
    };
  };

  let errorCaught = false;
  let receivedErrorText = '';
  let deltasInError = 0;

  try {
    await errorConnection.executeTurnStream(
      'mock_session_1',
      'Explain this architecture',
      () => {
        deltasInError++;
      }
    );
  } catch (err: unknown) {
    errorCaught = true;
    receivedErrorText = err instanceof Error ? err.message : String(err);
  }

  assert(errorCaught, 'Turn with error state throws an exception instead of silent completion');
  assert(
    receivedErrorText.includes(mockErrorMessage),
    'Actual provider error message is preserved in exception',
    `Expected "${mockErrorMessage}", received "${receivedErrorText}"`
  );
  assert(deltasInError === 0, 'No assistant deltas were emitted for error turn');

  // -----------------------------------------------------------------
  // SUITE 3: Paused Turn Handling
  // -----------------------------------------------------------------
  console.log('\n--- Suite 3: Paused Turn Handling ---');

  const pausedConnection = new TrueForgeConnection();

  // Mock createTurnStream to yield turn.update with paused state
  (pausedConnection.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'turn.update',
      id: 'evt_pause_1',
      createdAt: new Date().toISOString(),
      threadId: null,
      state: {
        status: 'paused'
      }
    };
  };

  let pauseCaught = false;
  let pauseMessage = '';

  try {
    await pausedConnection.executeTurnStream(
      'mock_session_paused',
      'Do something requiring input',
      () => {}
    );
  } catch (err: unknown) {
    pauseCaught = true;
    pauseMessage = err instanceof Error ? err.message : String(err);
  }

  assert(pauseCaught, 'Paused turn throws exception rather than returning empty successful response');
  assert(
    pauseMessage.includes('Turn paused: waiting for tool response or user input'),
    'Pause notification message explicitly describes waiting state',
    `Received: "${pauseMessage}"`
  );

  // -----------------------------------------------------------------
  // SUITE 4: Full model.message Event Handling (Non-Streaming / Assembled)
  // -----------------------------------------------------------------
  console.log('\n--- Suite 4: Full model.message Event Handling ---');

  const fullMsgConnection = new TrueForgeConnection();
  const assembledContent = 'Here is the full architectural breakdown of the extension.';
  const fullMsgDeltas: string[] = [];

  (fullMsgConnection.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'model.message',
      id: 'msg_full_1',
      createdAt: new Date().toISOString(),
      threadId: 'main',
      content: assembledContent
    };
    yield {
      type: 'turn.done',
      id: 'evt_done_full',
      createdAt: new Date().toISOString(),
      threadId: null,
      state: {
        status: 'done',
        completedAt: new Date().toISOString(),
        output: null,
        requiredActions: []
      }
    };
  };

  const fullMsgResult = await fullMsgConnection.executeTurnStream(
    'mock_session_full',
    'Explain architecture',
    (chunk) => {
      fullMsgDeltas.push(chunk);
    }
  );

  assert(fullMsgResult === assembledContent, 'executeTurnStream returns full model.message content');
  assert(fullMsgDeltas.length === 1 && fullMsgDeltas[0] === assembledContent, 'onDelta callback received assembled content once');

  // Also test array content inside full model.message
  const arrayMsgConnection = new TrueForgeConnection();
  (arrayMsgConnection.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'model.message',
      id: 'msg_arr_1',
      createdAt: new Date().toISOString(),
      threadId: 'main',
      content: [
        { type: 'text', text: 'Part A; ' },
        { type: 'text', text: 'Part B' }
      ]
    };
    yield {
      type: 'turn.done',
      id: 'evt_done_arr',
      createdAt: new Date().toISOString(),
      threadId: null,
      state: {
        status: 'done',
        completedAt: new Date().toISOString(),
        output: null,
        requiredActions: []
      }
    };
  };

  const arrayMsgResult = await arrayMsgConnection.executeTurnStream(
    'mock_session_arr',
    'List parts',
    () => {}
  );
  assert(arrayMsgResult === 'Part A; Part B', 'model.message with array-based content extracts correctly');

  // -----------------------------------------------------------------
  // SUITE 5: Deduplication: No Duplicate Text on Delta + model.message
  // -----------------------------------------------------------------
  console.log('\n--- Suite 5: Deduplication of Streaming Deltas and Assembled Messages ---');

  const dedupConnection = new TrueForgeConnection();
  const dedupDeltas: string[] = [];

  (dedupConnection.getClient().sessions as any).createTurnStream = async function* () {
    // Incremental deltas
    yield {
      type: 'model.message.delta',
      id: 'msg_dedup_1',
      content: 'Hello '
    };
    yield {
      type: 'model.message.delta',
      id: 'msg_dedup_1',
      content: 'World!'
    };
    // Full assembled message for the same message ID
    yield {
      type: 'model.message',
      id: 'msg_dedup_1',
      createdAt: new Date().toISOString(),
      threadId: 'main',
      content: 'Hello World!'
    };
    // Final turn.done with output
    yield {
      type: 'turn.done',
      id: 'evt_done_dedup',
      createdAt: new Date().toISOString(),
      threadId: null,
      state: {
        status: 'done',
        completedAt: new Date().toISOString(),
        output: {
          id: 'msg_dedup_1',
          content: 'Hello World!'
        },
        requiredActions: []
      }
    };
  };

  const dedupResult = await dedupConnection.executeTurnStream(
    'mock_session_dedup',
    'Say hello',
    (chunk) => {
      dedupDeltas.push(chunk);
    }
  );

  assert(dedupResult === 'Hello World!', `Full response is "Hello World!" without repetition (length: ${dedupResult.length})`);
  assert(
    dedupDeltas.join('') === 'Hello World!',
    'Accumulated onDelta chunks equal "Hello World!"'
  );
  assert(
    dedupDeltas.length === 2,
    `onDelta was called exactly twice (for the two deltas), not for assembled message (got: ${dedupDeltas.length} calls)`
  );

  // -----------------------------------------------------------------
  // SUITE 6: Empty Successful Turn and Fallback Behavior
  // -----------------------------------------------------------------
  console.log('\n--- Suite 6: Empty Response Handling & Fallback ---');

  const emptyConnection = new TrueForgeConnection();
  (emptyConnection.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'turn.done',
      id: 'evt_done_empty',
      createdAt: new Date().toISOString(),
      threadId: null,
      state: {
        status: 'done',
        completedAt: new Date().toISOString(),
        output: null,
        requiredActions: []
      }
    };
  };

  const emptyResult = await emptyConnection.executeTurnStream(
    'mock_session_empty',
    'Trigger empty turn',
    () => {}
  );
  assert(emptyResult === '', 'Genuinely empty successful turn returns empty string from connection');

  // Verify fallback text logic used by SidebarChatProvider
  const fallbackNotice = '*(No text response generated by agent)*';
  const chatDisplayContent = emptyResult.trim() === '' ? fallbackNotice : emptyResult;
  assert(
    chatDisplayContent === fallbackNotice,
    'UI fallback generates explicit notice: *(No text response generated by agent)*'
  );

  // Fallback to turn.done output when deltas/model.message are absent
  const fallbackConnection = new TrueForgeConnection();
  (fallbackConnection.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'turn.done',
      id: 'evt_done_fallback',
      createdAt: new Date().toISOString(),
      threadId: null,
      state: {
        status: 'done',
        completedAt: new Date().toISOString(),
        output: {
          id: 'msg_fb',
          content: 'Output recovered from turn.done'
        },
        requiredActions: []
      }
    };
  };

  const fallbackResult = await fallbackConnection.executeTurnStream(
    'mock_session_fb',
    'Recover output',
    () => {}
  );
  assert(
    fallbackResult === 'Output recovered from turn.done',
    'turn.done output used as fallback when deltas are absent'
  );

  // -----------------------------------------------------------------
  // SUITE 7: Cancelled Turn State
  // -----------------------------------------------------------------
  console.log('\n--- Suite 7: Cancelled Turn Handling ---');

  const cancelConnection = new TrueForgeConnection();
  (cancelConnection.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'turn.done',
      id: 'evt_done_cancel',
      createdAt: new Date().toISOString(),
      threadId: null,
      state: {
        status: 'cancelled',
        reason: 'user_cancelled',
        completedAt: new Date().toISOString()
      }
    };
  };

  let cancelCaught = false;
  let cancelMessage = '';

  try {
    await cancelConnection.executeTurnStream(
      'mock_session_cancel',
      'Task to cancel',
      () => {}
    );
  } catch (err: unknown) {
    cancelCaught = true;
    cancelMessage = err instanceof Error ? err.message : String(err);
  }

  assert(cancelCaught, 'Cancelled turn throws exception rather than returning empty success');
  assert(
    cancelMessage.includes('cancelled'),
    'Cancelled exception explicitly indicates cancellation',
    `Received: "${cancelMessage}"`
  );

  // -----------------------------------------------------------------
  // SUITE 8: Paused Turn Continuation with Active Content
  // -----------------------------------------------------------------
  console.log('\n--- Suite 8: Paused Turn Continuation with Active Content ---');

  const pausedContinuationConnection = new TrueForgeConnection();
  const streamedContent = 'I will inspect the workspace.\nTOOL_CALL:\n```json\n{ "tool": "search_code", "arguments": { "query": "def get_debug_flag()" } }\n```';

  (pausedContinuationConnection.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'model.message.delta',
      id: 'msg_paused_cont_1',
      content: streamedContent
    };
    yield {
      type: 'turn.update',
      id: 'evt_paused_update_1',
      state: {
        status: 'paused'
      }
    };
  };

  let pauseContinuationCaught = false;
  let pauseContinuationResult = '';

  try {
    pauseContinuationResult = await pausedContinuationConnection.executeTurnStream(
      'mock_session_paused_cont',
      'Search for function',
      () => {}
    );
  } catch (err: unknown) {
    pauseContinuationCaught = true;
  }

  assert(!pauseContinuationCaught, 'Paused turn with active streamed content does NOT throw an error');
  assert(
    pauseContinuationResult === streamedContent,
    'executeTurnStream returns active content when turn pauses with output'
  );

  // -----------------------------------------------------------------
  // SUITE 9: Native Tool Call Event Extraction from model.message & tool.response_required
  // -----------------------------------------------------------------
  console.log('\n--- Suite 9: Native Tool Call Event Extraction ---');

  const nativeToolConnection = new TrueForgeConnection();
  (nativeToolConnection.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'model.message',
      id: 'msg_native_tool_1',
      threadId: 'main',
      content: null,
      toolCalls: [
        {
          id: 'call_native_1',
          type: 'function',
          function: {
            name: 'search_code',
            arguments: JSON.stringify({ query: 'def get_debug_flag()' })
          }
        }
      ]
    };
    yield {
      type: 'tool.response_required',
      id: 'evt_tool_resp_req_1',
      toolCalls: [
        { id: 'call_native_1', sourceEventId: 'msg_native_tool_1' }
      ]
    };
    yield {
      type: 'turn.update',
      id: 'evt_pause_after_tool',
      state: {
        status: 'paused'
      }
    };
  };

  const nativeToolResult = await nativeToolConnection.executeTurnStream(
    'mock_session_native_tool',
    'Find function',
    () => {}
  );

  assert(nativeToolResult.includes('TOOL_CALL:'), 'Synthesizes TOOL_CALL block from native toolCalls event');
  assert(nativeToolResult.includes('"tool": "search_code"'), 'Tool name matches native toolCall');
  assert(nativeToolResult.includes('def get_debug_flag()'), 'Tool arguments match native toolCall');

  // -----------------------------------------------------------------
  // SUITE 10: Genuine User-Input Pause (0 content + paused status)
  // -----------------------------------------------------------------
  console.log('\n--- Suite 10: Genuine User-Input Pause ---');

  const genuineUserPauseConnection = new TrueForgeConnection();
  (genuineUserPauseConnection.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'turn.update',
      id: 'evt_genuine_pause_1',
      state: {
        status: 'paused'
      }
    };
  };

  let genuinePauseCaught = false;
  let genuinePauseMessage = '';

  try {
    await genuineUserPauseConnection.executeTurnStream(
      'mock_session_genuine_pause',
      'Ask user confirmation',
      () => {}
    );
  } catch (err: unknown) {
    genuinePauseCaught = true;
    genuinePauseMessage = err instanceof Error ? err.message : String(err);
  }

  assert(genuinePauseCaught, 'Genuinely empty paused turn throws to signal waiting for input');
  assert(
    genuinePauseMessage.includes('Turn paused: waiting for'),
    'Genuinely empty paused turn describes waiting for input'
  );

  // -----------------------------------------------------------------
  // SUITE 11: TrueForge Native Tool Calling Protocol & Lifecycle Unit Tests
  // -----------------------------------------------------------------
  console.log('\n--- Suite 11: TrueForge Native Tool Calling Protocol & Lifecycle ---');

  // 11.1 Capture turnId from turn.created
  const turnCaptureConn = new TrueForgeConnection();
  (turnCaptureConn.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'turn.created',
      id: 'evt_tc_1',
      turnId: 'turn_captured_999'
    };
    yield {
      type: 'model.message.delta',
      id: 'delta_1',
      content: 'Turn initialized.'
    };
    yield {
      type: 'turn.done',
      id: 'done_1',
      state: { status: 'done' }
    };
  };

  await turnCaptureConn.executeTurnStream('sess_1', 'Hello', () => {});
  assert(turnCaptureConn.getLastTurnId() === 'turn_captured_999', 'turnId correctly captured from turn.created');

  // 11.2 Structured tool call matching, tool response submission, and cursor resumption
  const nativeLifecycleConn = new TrueForgeConnection();
  let submittedTurnEvents: any = null;
  let subscribedTurnRequest: any = null;
  let executedToolName = '';
  let executedToolArgs: any = null;

  (nativeLifecycleConn.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'turn.created',
      id: 'evt_tc_2',
      turnId: 'turn_native_lifecycle_1'
    };
    yield {
      type: 'model.message',
      id: 'msg_evt_1',
      threadId: 'main_thread',
      toolCalls: [
        {
          id: 'call_lifecycle_1',
          type: 'function',
          function: {
            name: 'search_code',
            arguments: JSON.stringify({ query: 'get_debug_flag' })
          }
        }
      ]
    };
    yield {
      type: 'tool.response_required',
      id: 'evt_resp_req_1',
      threadId: 'main_thread',
      toolCalls: [
        { id: 'call_lifecycle_1', sourceEventId: 'msg_evt_1' }
      ]
    };
    yield {
      type: 'turn.update',
      id: 'evt_upd_1',
      state: { status: 'paused' }
    };
  };

  (nativeLifecycleConn.getClient().sessions as any).createTurnEvents = async (
    sessionId: string,
    turnId: string,
    request: any
  ) => {
    submittedTurnEvents = { sessionId, turnId, request };
    return { success: true };
  };

  (nativeLifecycleConn.getClient().sessions as any).subscribeToTurn = async function* (
    sessionId: string,
    turnId: string,
    request: any
  ) {
    subscribedTurnRequest = { sessionId, turnId, request };
    yield {
      type: 'model.message.delta',
      id: 'delta_final',
      content: 'Found get_debug_flag in helpers.py.'
    };
    yield {
      type: 'turn.done',
      id: 'done_2',
      state: { status: 'done' }
    };
  };

  const finalRes = await nativeLifecycleConn.executeTurnStream(
    'sess_lifecycle_1',
    'Find debug flag',
    {
      toolExecutor: async (name, args) => {
        executedToolName = name;
        executedToolArgs = args;
        return { success: true, output: 'helpers.py:28: def get_debug_flag()' };
      }
    }
  );

  assert(executedToolName === 'search_code', 'Tool dispatcher called correct tool name');
  assert(executedToolArgs?.query === 'get_debug_flag', 'Tool dispatcher received parsed arguments');
  assert(submittedTurnEvents !== null, 'createTurnEvents was invoked');
  assert(submittedTurnEvents.turnId === 'turn_native_lifecycle_1', 'createTurnEvents targeted correct turnId');
  assert(submittedTurnEvents.request.events.length === 1, 'Submitted 1 user.tool_response event');
  assert(submittedTurnEvents.request.events[0].type === 'user.tool_response', 'Event type is user.tool_response');
  assert(submittedTurnEvents.request.events[0].toolCallId === 'call_lifecycle_1', 'Event references correct toolCallId');
  assert(submittedTurnEvents.request.events[0].threadId === 'main_thread', 'Event references correct threadId');
  assert(submittedTurnEvents.request.events[0].content.includes('helpers.py:28'), 'Event contains tool output');
  assert(subscribedTurnRequest !== null, 'subscribeToTurn was invoked');
  assert(subscribedTurnRequest.request.afterEventId === 'evt_upd_1', 'subscribeToTurn used verified afterEventId cursor');
  assert(finalRes.includes('Found get_debug_flag'), 'Full turn response includes resumed message content');

  // 11.3 Multiple pending tool calls in a single response_required event
  const multiToolConn = new TrueForgeConnection();
  let multiSubmittedEvents: any = null;

  (multiToolConn.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'turn.created',
      id: 'evt_tc_3',
      turnId: 'turn_multi_1'
    };
    yield {
      type: 'model.message',
      id: 'msg_evt_multi',
      threadId: 'thread_multi',
      toolCalls: [
        {
          id: 'call_multi_1',
          type: 'function',
          function: {
            name: 'list_files',
            arguments: JSON.stringify({ directory: 'src' })
          }
        },
        {
          id: 'call_multi_2',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'src/helpers.py', startLine: 1, endLine: 10 })
          }
        }
      ]
    };
    yield {
      type: 'tool.response_required',
      id: 'evt_resp_req_multi',
      threadId: 'thread_multi',
      toolCalls: [
        { id: 'call_multi_1', sourceEventId: 'msg_evt_multi' },
        { id: 'call_multi_2', sourceEventId: 'msg_evt_multi' }
      ]
    };
  };

  (multiToolConn.getClient().sessions as any).createTurnEvents = async (
    _sessionId: string,
    _turnId: string,
    request: any
  ) => {
    multiSubmittedEvents = request.events;
    return { success: true };
  };

  (multiToolConn.getClient().sessions as any).subscribeToTurn = async function* () {
    yield {
      type: 'turn.done',
      id: 'done_multi',
      state: { status: 'done' }
    };
  };

  const executedTools: string[] = [];
  await multiToolConn.executeTurnStream('sess_multi', 'Inspect src', {
    toolExecutor: async (name) => {
      executedTools.push(name);
      return { success: true, output: `Result for ${name}` };
    }
  });

  assert(executedTools.length === 2, 'Both pending tools executed');
  assert(executedTools[0] === 'list_files' && executedTools[1] === 'read_file', 'Tools executed in requested order');
  assert(multiSubmittedEvents.length === 2, 'Both tool responses submitted in single createTurnEvents call');
  assert(multiSubmittedEvents[0].toolCallId === 'call_multi_1', 'First toolCallId matches call_multi_1');
  assert(multiSubmittedEvents[1].toolCallId === 'call_multi_2', 'Second toolCallId matches call_multi_2');

  // 11.4 Sequential tool cycles on the same turn
  const sequentialConn = new TrueForgeConnection();
  let cycle = 0;

  (sequentialConn.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'turn.created',
      id: 'evt_seq_0',
      turnId: 'turn_seq_1'
    };
    yield {
      type: 'model.message',
      id: 'msg_seq_1',
      toolCalls: [
        {
          id: 'call_seq_1',
          type: 'function',
          function: { name: 'list_files', arguments: '{}' }
        }
      ]
    };
    yield {
      type: 'tool.response_required',
      id: 'evt_seq_req_1',
      toolCalls: [{ id: 'call_seq_1', sourceEventId: 'msg_seq_1' }]
    };
  };

  (sequentialConn.getClient().sessions as any).createTurnEvents = async () => ({ success: true });
  (sequentialConn.getClient().sessions as any).subscribeToTurn = async function* (
    _sessionId: string,
    _turnId: string,
    req: any
  ) {
    cycle++;
    if (cycle === 1) {
      assert(req.afterEventId === 'evt_seq_req_1', 'Cycle 1 resumes with evt_seq_req_1');
      yield {
        type: 'model.message',
        id: 'msg_seq_2',
        toolCalls: [
          {
            id: 'call_seq_2',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"file.ts"}' }
          }
        ]
      };
      yield {
        type: 'tool.response_required',
        id: 'evt_seq_req_2',
        toolCalls: [{ id: 'call_seq_2', sourceEventId: 'msg_seq_2' }]
      };
    } else {
      assert(req.afterEventId === 'evt_seq_req_2', 'Cycle 2 resumes with evt_seq_req_2');
      yield {
        type: 'model.message.delta',
        id: 'delta_seq_done',
        content: 'Sequential cycles complete.'
      };
      yield {
        type: 'turn.done',
        id: 'done_seq',
        state: { status: 'done' }
      };
    }
  };

  const seqResult = await sequentialConn.executeTurnStream('sess_seq', 'Multi-cycle task', {
    toolExecutor: async (name) => ({ success: true, output: `Done ${name}` })
  });

  assert(cycle === 2, 'Executed 2 sequential tool cycles on the same turn');
  assert(seqResult.includes('Sequential cycles complete'), 'Final message returned after sequential cycles');

  // 11.5 Unmatched tool-call reference handling (never guess missing arguments)
  const unmatchedConn = new TrueForgeConnection();
  let unmatchedEvents: any = null;

  (unmatchedConn.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'turn.created',
      id: 'evt_tc_unmatched',
      turnId: 'turn_unmatched_1'
    };
    yield {
      type: 'tool.response_required',
      id: 'evt_req_ghost',
      toolCalls: [
        { id: 'call_ghost_999', sourceEventId: 'msg_non_existent' }
      ]
    };
  };

  (unmatchedConn.getClient().sessions as any).createTurnEvents = async (_s: string, _t: string, req: any) => {
    unmatchedEvents = req.events;
    return { success: true };
  };

  (unmatchedConn.getClient().sessions as any).subscribeToTurn = async function* () {
    yield {
      type: 'turn.done',
      id: 'done_ghost',
      state: { status: 'done' }
    };
  };

  await unmatchedConn.executeTurnStream('sess_unmatched', 'Run ghost tool', {
    toolExecutor: async () => ({ success: true, output: 'Should not run' })
  });

  assert(unmatchedEvents.length === 1, 'Submitted response for unmatched tool call');
  assert(unmatchedEvents[0].toolCallId === 'call_ghost_999', 'Tool response references ghost toolCallId');
  assert(unmatchedEvents[0].content.includes('UNMATCHED_TOOL_CALL'), 'Submitted UNMATCHED_TOOL_CALL error without guessing');

  // 11.6 Malformed JSON arguments handling (never guess arguments)
  const malformedConn = new TrueForgeConnection();
  let malformedEvents: any = null;

  (malformedConn.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'turn.created',
      id: 'evt_tc_malformed',
      turnId: 'turn_malformed_1'
    };
    yield {
      type: 'model.message',
      id: 'msg_malformed_1',
      toolCalls: [
        {
          id: 'call_bad_json',
          type: 'function',
          function: {
            name: 'search_code',
            arguments: '{ query: unquoted invalid json...'
          }
        }
      ]
    };
    yield {
      type: 'tool.response_required',
      id: 'evt_req_malformed',
      toolCalls: [{ id: 'call_bad_json', sourceEventId: 'msg_malformed_1' }]
    };
  };

  (malformedConn.getClient().sessions as any).createTurnEvents = async (_s: string, _t: string, req: any) => {
    malformedEvents = req.events;
    return { success: true };
  };

  (malformedConn.getClient().sessions as any).subscribeToTurn = async function* () {
    yield {
      type: 'turn.done',
      id: 'done_malformed',
      state: { status: 'done' }
    };
  };

  let badToolExecuted = false;
  await malformedConn.executeTurnStream('sess_malformed', 'Bad args test', {
    toolExecutor: async () => {
      badToolExecuted = true;
      return { success: true, output: 'ok' };
    }
  });

  assert(!badToolExecuted, 'Tool was not executed with malformed arguments');
  assert(malformedEvents.length === 1, 'Submitted error response for malformed JSON arguments');
  assert(malformedEvents[0].toolCallId === 'call_bad_json', 'Tool response references call_bad_json');
  assert(malformedEvents[0].content.includes('MALFORMED_ARGUMENTS'), 'Submitted MALFORMED_ARGUMENTS error without guessing');

  // 11.7 Unknown tool name handling
  const unknownToolConn = new TrueForgeConnection();
  let unknownEvents: any = null;

  (unknownToolConn.getClient().sessions as any).createTurnStream = async function* () {
    yield {
      type: 'turn.created',
      id: 'evt_tc_unknown',
      turnId: 'turn_unknown_1'
    };
    yield {
      type: 'model.message',
      id: 'msg_unknown_1',
      toolCalls: [
        {
          id: 'call_unknown_1',
          type: 'function',
          function: {
            name: 'non_existent_tool_xyz',
            arguments: JSON.stringify({ foo: 'bar' })
          }
        }
      ]
    };
    yield {
      type: 'tool.response_required',
      id: 'evt_req_unknown',
      toolCalls: [{ id: 'call_unknown_1', sourceEventId: 'msg_unknown_1' }]
    };
  };

  (unknownToolConn.getClient().sessions as any).createTurnEvents = async (_s: string, _t: string, req: any) => {
    unknownEvents = req.events;
    return { success: true };
  };

  (unknownToolConn.getClient().sessions as any).subscribeToTurn = async function* () {
    yield {
      type: 'turn.done',
      id: 'done_unknown',
      state: { status: 'done' }
    };
  };

  await unknownToolConn.executeTurnStream('sess_unknown', 'Unknown tool test', {
    toolExecutor: async (name) => {
      return { success: false, error: 'UNKNOWN_TOOL', output: `Unknown tool: ${name}` };
    }
  });

  assert(unknownEvents.length === 1, 'Submitted response for unknown tool');
  assert(unknownEvents[0].content.includes('Unknown tool: non_existent_tool_xyz'), 'Fed back UNKNOWN_TOOL message to server');

  // -----------------------------------------------------------------
  // SUMMARY
  // -----------------------------------------------------------------
  console.log('\n====================================================');
  console.log(`  TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Unhandled test suite error:', err);
  process.exit(1);
});
