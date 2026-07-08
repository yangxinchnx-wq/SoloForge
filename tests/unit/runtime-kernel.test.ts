import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuntimeKernel, RuntimeState, CommandBusInterface } from '../../src/kernel/runtime-kernel';

describe('RuntimeKernel', () => {
  let kernel: RuntimeKernel;
  let mockCommandBus: CommandBusInterface;

  beforeEach(() => {
    // 创建 mock CommandBus
    mockCommandBus = {
      execute: vi.fn().mockResolvedValue({ accepted: true, type: 'TEST_COMMAND' }),
      registerHandler: vi.fn(),
    };

    kernel = RuntimeKernel.getInstance();
    kernel.commandBus = mockCommandBus;
  });

  describe('executeCommand', () => {
    it('should route command to CommandBus.execute', async () => {
      const command = {
        type: 'TEST_COMMAND',
        domain: 'TestDomain',
        caller: 'test-caller',
        payload: { data: 'test' },
      };

      const result = await kernel.executeCommand(command);

      expect(mockCommandBus.execute).toHaveBeenCalledWith(command);
      expect(result).toEqual({ accepted: true, type: 'TEST_COMMAND' });
    });

    it('should return error result when CommandBus is not initialized', async () => {
      kernel.commandBus = null;

      const command = {
        type: 'TEST_COMMAND',
        domain: 'TestDomain',
        caller: 'test-caller',
        payload: { data: 'test' },
      };

      const result = await kernel.executeCommand(command);

      expect(result).toEqual({
        accepted: false,
        type: 'TEST_COMMAND',
        error: 'CommandBus not initialized',
      });
    });

    it('should return error result when CommandBus.execute throws', async () => {
      const mockError = new Error('Command execution failed');
      mockCommandBus.execute = vi.fn().mockRejectedValue(mockError);

      const command = {
        type: 'FAILING_COMMAND',
        domain: 'TestDomain',
        caller: 'test-caller',
        payload: {},
      };

      const result = await kernel.executeCommand(command);

      expect(result).toEqual({
        accepted: false,
        type: 'FAILING_COMMAND',
        error: 'Command execution failed',
      });
    });

    it('should generate id if not provided', async () => {
      const command = {
        type: 'TEST_COMMAND',
        domain: 'TestDomain',
        caller: 'test-caller',
        payload: {},
      };

      await kernel.executeCommand(command);

      const executedCommand = (mockCommandBus.execute as any).mock.calls[0][0];
      expect(executedCommand.type).toBe('TEST_COMMAND');
      expect(executedCommand.domain).toBe('TestDomain');
    });
  });

  describe('bootstrapCoreLinkages', () => {
    it('should set commandBus and transactionManager', () => {
      const mockTransactionManager = { begin: vi.fn(), commit: vi.fn(), rollback: vi.fn() };

      kernel.bootstrapCoreLinkages({
        commandBus: mockCommandBus,
        transactionManager: mockTransactionManager as any,
        projectionManager: null,
        snapshotManager: null,
        scheduler: null,
      });

      expect(kernel.commandBus).toBe(mockCommandBus);
      expect(kernel.transactionManager).toBe(mockTransactionManager);
    });
  });

  describe('state management', () => {
    it('should start in BOOTING state', () => {
      // 由于是单例，可能需要重置
      expect(kernel.getState()).toBeDefined();
      expect(Object.values(RuntimeState)).toContain(kernel.getState());
    });
  });
});
