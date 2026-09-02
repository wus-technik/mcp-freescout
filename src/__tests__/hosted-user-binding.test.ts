import { createFreeScoutMcpServer } from '../server.js';

type RegisteredTool = {
  handler: (input: Record<string, unknown>) => Promise<unknown>;
};

type FakeApi = {
  parseTicketInput: (ticket: string) => string;
  addThread: jest.Mock;
  updateConversation: jest.Mock;
  createDraftReply: jest.Mock;
  sendReply: jest.Mock;
  getConversation: jest.Mock;
  getCurrentUser: jest.Mock;
};

const createFakeApi = (): FakeApi => ({
  parseTicketInput: (ticket: string) => ticket.replace(/\D/g, '') || ticket,
  addThread: jest.fn(async () => ({ id: 10 })),
  updateConversation: jest.fn(async () => ({})),
  createDraftReply: jest.fn(async () => ({ id: 20 })),
  sendReply: jest.fn(async () => ({ id: 30 })),
  getConversation: jest.fn(async () => ({ to: ['customer@example.com'] })),
  getCurrentUser: jest.fn(async () => ({ id: 99 })),
});

const analyzer = {
  analyzeConversation: jest.fn(),
  stripHtml: jest.fn((value: string) => value),
};

function getToolHandler(
  mode: 'default' | 'authenticated',
  toolName: string,
  api: FakeApi
): RegisteredTool['handler'] {
  const server = createFreeScoutMcpServer({
    api: api as never,
    analyzer: analyzer as never,
    defaultUserId: 7,
    userBinding: mode,
    version: 'test',
  });

  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  return tools[toolName].handler;
}

describe('hosted user binding for mutating tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves stdio behavior for add note', async () => {
    const api = createFakeApi();
    const handler = getToolHandler('default', 'freescout_add_note', api);

    await handler({ ticket: '123', note: 'hello' });
    await handler({ ticket: '123', note: 'hello', userId: 42 });

    expect(api.addThread).toHaveBeenNthCalledWith(1, '123', 'note', 'hello', 7);
    expect(api.addThread).toHaveBeenNthCalledWith(2, '123', 'note', 'hello', 42);
    expect(api.getCurrentUser).not.toHaveBeenCalled();
  });

  it('binds hosted add note to the authenticated user', async () => {
    const api = createFakeApi();
    const handler = getToolHandler('authenticated', 'freescout_add_note', api);

    await handler({ ticket: '123', note: 'hello', userId: 42 });

    expect(api.getCurrentUser).toHaveBeenCalled();
    expect(api.addThread).toHaveBeenCalledWith('123', 'note', 'hello', 99);
  });

  it('preserves stdio behavior for update ticket', async () => {
    const api = createFakeApi();
    const handler = getToolHandler('default', 'freescout_update_ticket', api);

    await handler({ ticket: '123', status: 'pending', assignTo: 99 });

    expect(api.updateConversation).toHaveBeenCalledWith('123', {
      byUser: 7,
      status: 'pending',
      assignTo: 99,
    });
  });

  it('binds hosted update ticket to the authenticated user', async () => {
    const api = createFakeApi();
    const handler = getToolHandler('authenticated', 'freescout_update_ticket', api);

    await handler({ ticket: '123', status: 'pending', assignTo: 99 });

    expect(api.updateConversation).toHaveBeenCalledWith('123', {
      status: 'pending',
      assignTo: 99,
    });
  });

  it('preserves stdio behavior for draft replies', async () => {
    const api = createFakeApi();
    const handler = getToolHandler('default', 'freescout_create_draft_reply', api);

    await handler({ ticket: '123', replyText: 'draft body' });
    await handler({ ticket: '123', replyText: 'draft body', userId: 42 });

    expect(api.createDraftReply).toHaveBeenNthCalledWith(
      1,
      '123',
      'draft body',
      7,
      { to: ['customer@example.com'], cc: undefined, bcc: undefined }
    );
    expect(api.createDraftReply).toHaveBeenNthCalledWith(
      2,
      '123',
      'draft body',
      42,
      { to: ['customer@example.com'], cc: undefined, bcc: undefined }
    );
    expect(api.getCurrentUser).not.toHaveBeenCalled();
  });

  it('binds hosted draft replies to the authenticated user', async () => {
    const api = createFakeApi();
    const handler = getToolHandler('authenticated', 'freescout_create_draft_reply', api);

    await handler({ ticket: '123', replyText: 'draft body', userId: 42 });

    expect(api.getCurrentUser).toHaveBeenCalled();
    expect(api.createDraftReply).toHaveBeenCalledWith(
      '123',
      'draft body',
      99,
      { to: ['customer@example.com'], cc: undefined, bcc: undefined }
    );
  });

  it('refuses to send without confirm:true', async () => {
    const api = createFakeApi();
    const handler = getToolHandler('default', 'freescout_send_reply', api);

    const result = (await handler({ ticket: '123', replyText: 'real reply' })) as {
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(api.sendReply).not.toHaveBeenCalled();
  });

  it('preserves stdio behavior for send reply when confirmed', async () => {
    const api = createFakeApi();
    const handler = getToolHandler('default', 'freescout_send_reply', api);

    await handler({ ticket: '123', replyText: 'real reply', confirm: true });
    await handler({ ticket: '123', replyText: 'real reply', confirm: true, userId: 42 });

    expect(api.sendReply).toHaveBeenNthCalledWith(
      1,
      '123',
      'real reply',
      7,
      { to: ['customer@example.com'], cc: undefined, bcc: undefined }
    );
    expect(api.sendReply).toHaveBeenNthCalledWith(
      2,
      '123',
      'real reply',
      42,
      { to: ['customer@example.com'], cc: undefined, bcc: undefined }
    );
    expect(api.getCurrentUser).not.toHaveBeenCalled();
  });

  it('binds hosted send reply to the authenticated user when confirmed', async () => {
    const api = createFakeApi();
    const handler = getToolHandler('authenticated', 'freescout_send_reply', api);

    await handler({ ticket: '123', replyText: 'real reply', confirm: true, userId: 42 });

    expect(api.getCurrentUser).toHaveBeenCalled();
    expect(api.sendReply).toHaveBeenCalledWith(
      '123',
      'real reply',
      99,
      { to: ['customer@example.com'], cc: undefined, bcc: undefined }
    );
  });
});
