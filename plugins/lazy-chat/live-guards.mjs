function isOutboundRequest(event) {
  return (
    event?.type === "client/turn/requested" &&
    event.data?.direction === "outbound" &&
    typeof event.data?.requestId === "string" &&
    event.data.requestId.length > 0
  );
}

function collectRequests(events) {
  const requests = events.filter(isOutboundRequest);
  const seen = new Set();
  for (const request of requests) {
    const id = request.data.requestId;
    if (seen.has(id)) throw new Error(`Duplicate outbound requestId: ${id}`);
    seen.add(id);
  }
  return requests;
}

export function captureRequestIds(events) {
  return new Set(collectRequests(events).map((event) => event.data.requestId));
}

export function newRequests(baselineIds, events) {
  const baseline =
    baselineIds instanceof Set ? baselineIds : new Set(baselineIds);
  return collectRequests(events).filter(
    (event) => !baseline.has(event.data.requestId),
  );
}

export function assertNoUnexpectedRequests(baselineIds, events) {
  const unexpected = newRequests(baselineIds, events);
  if (unexpected.length > 0) {
    const ids = unexpected.map((event) => event.data.requestId);
    const error = new Error(
      `Unexpected setup-time request(s): ${ids.join(", ")}`,
    );
    error.unexpectedRequestIds = ids;
    throw error;
  }
  return unexpected;
}

export function assertExactlyOneNewRequest(
  baselineIds,
  events,
  expectedInitiator,
) {
  const requests = newRequests(baselineIds, events);
  if (
    requests.length !== 1 ||
    requests[0]?.data?.initiator !== expectedInitiator
  ) {
    const details = requests
      .map((event) => `${event.data.requestId}/${event.data.initiator}`)
      .join(", ");
    const error = new Error(
      `Expected exactly one new ${expectedInitiator} request, found ${requests.length}: ${details}`,
    );
    error.unexpectedRequestIds = requests.map((event) => event.data.requestId);
    throw error;
  }
  return requests[0];
}

export function assertUniqueActiveSuggestion(rows, expectedTitle) {
  const activeIndexes = [];
  const matchingActiveIndexes = [];
  rows.forEach((row, index) => {
    if (row.active) activeIndexes.push(index);
    if (row.active && row.title === expectedTitle)
      matchingActiveIndexes.push(index);
  });
  if (activeIndexes.length !== 1 || matchingActiveIndexes.length !== 1) {
    throw new Error(
      `Expected exactly one active suggestion titled ${JSON.stringify(expectedTitle)}; found ${matchingActiveIndexes.length} matching and ${activeIndexes.length} active`,
    );
  }
  return rows[matchingActiveIndexes[0]];
}

export function correlateAcceptedCompletion(
  events,
  requestId,
  threadId,
  expectedInitiator,
) {
  const requested = events.filter(
    (event) =>
      isOutboundRequest(event) &&
      event.threadId === threadId &&
      event.data.requestId === requestId,
  );
  if (requested.length !== 1)
    throw new Error(
      `Expected one outbound request ${requestId} in ${threadId}`,
    );
  const request = requested[0];
  if (request.data.initiator !== expectedInitiator)
    throw new Error(
      `Request ${requestId} has unexpected initiator ${request.data.initiator}`,
    );

  const accepted = events.filter(
    (event) =>
      event.type === "turn/input/accepted" &&
      event.threadId === threadId &&
      event.data?.clientRequestId === requestId,
  );
  if (accepted.length !== 1)
    throw new Error(`Expected one accepted-input mapping for ${requestId}`);
  const input = accepted[0];
  if (
    input.scope?.kind !== "turn" ||
    typeof input.scope.turnId !== "string" ||
    input.scope.turnId.length === 0
  )
    throw new Error(`Accepted input for ${requestId} has no turn identity`);
  if (request.seq >= input.seq)
    throw new Error(`Accepted input for ${requestId} precedes its request`);

  const completed = events.filter(
    (event) =>
      event.type === "turn/completed" &&
      event.threadId === threadId &&
      event.scope?.kind === "turn" &&
      event.scope.turnId === input.scope.turnId,
  );
  if (completed.length !== 1)
    throw new Error(
      `Expected one completion for accepted turn ${input.scope.turnId}`,
    );
  const completion = completed[0];
  if (completion.data?.status !== "completed")
    throw new Error(
      `Accepted turn ${input.scope.turnId} did not complete successfully`,
    );
  if (input.seq >= completion.seq)
    throw new Error(
      `Completion precedes accepted input for ${input.scope.turnId}`,
    );
  return {
    request,
    accepted: input,
    completed: completion,
    turnId: input.scope.turnId,
  };
}
