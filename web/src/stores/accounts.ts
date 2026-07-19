import { create } from 'zustand';
import type { Account, PaginatedResponse, ImportRequest, ImportResult, ExportRequest } from '../types';
import { accountApi } from '../lib/api';

interface AccountStore {
  accounts: Account[];
  loading: boolean;
  selectedIds: number[];
  searchQuery: string;
  joinedDate: string;
  pagination: { page: number; pageSize: number; total: number };
  fetchAccounts: () => Promise<void>;
  refreshAccountsSilent: () => Promise<void>;
  createAccount: (data: Partial<Account>) => Promise<void>;
  updateAccount: (id: number, data: Partial<Account>) => Promise<void>;
  deleteAccount: (id: number) => Promise<void>;
  batchDelete: (ids: number[]) => Promise<void>;
  importAccounts: (req: ImportRequest) => Promise<ImportResult>;
  exportAccounts: (req: ExportRequest) => Promise<string>;
  setSelectedIds: (ids: number[]) => void;
  setSearchQuery: (q: string) => void;
  setJoinedDate: (date: string) => void;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
}

function toSqliteUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function getJoinedDateRange(joinedDate: string): { joinedFrom?: string; joinedTo?: string } {
  if (!joinedDate) return {};
  const start = new Date(`${joinedDate}T00:00:00`);
  if (Number.isNaN(start.getTime())) return {};
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { joinedFrom: toSqliteUtc(start), joinedTo: toSqliteUtc(end) };
}

export const useAccountStore = create<AccountStore>((set, get) => ({
  accounts: [],
  loading: false,
  selectedIds: [],
  searchQuery: '',
  joinedDate: '',
  pagination: { page: 1, pageSize: 20, total: 0 },

  fetchAccounts: async () => {
    set({ loading: true });
    try {
      const { page, pageSize } = get().pagination;
      const data = await accountApi.list({ page, pageSize, search: get().searchQuery, ...getJoinedDateRange(get().joinedDate) });
      set({ accounts: data.list, pagination: { page: data.page, pageSize: data.pageSize, total: data.total } });
    } finally {
      set({ loading: false });
    }
  },

  refreshAccountsSilent: async () => {
    try {
      const { page, pageSize } = get().pagination;
      const data = await accountApi.list({ page, pageSize, search: get().searchQuery, ...getJoinedDateRange(get().joinedDate) });
      set(state => ({
        accounts: state.accounts.map(acc => {
          const fresh = data.list.find(a => a.id === acc.id);
          return fresh ?? acc;
        }),
      }));
    } catch {
      // 静默失败，不影响用户操作
    }
  },

  createAccount: async (data) => {
    await accountApi.create(data);
    await get().fetchAccounts();
  },

  updateAccount: async (id, data) => {
    const updated = await accountApi.update(id, data);
    set(state => ({
      accounts: state.accounts.map(acc => acc.id === id ? updated : acc),
    }));
  },

  deleteAccount: async (id) => {
    await accountApi.delete(id);
    await get().fetchAccounts();
  },

  batchDelete: async (ids) => {
    await accountApi.batchDelete(ids);
    set({ selectedIds: [] });
    await get().fetchAccounts();
  },

  importAccounts: async (req) => {
    const result = await accountApi.import(req);
    await get().fetchAccounts();
    return result;
  },

  exportAccounts: async (req) => {
    const result = await accountApi.export(req);
    return result.content;
  },

  setSelectedIds: (ids) => set({ selectedIds: ids }),
  setSearchQuery: (q) => { set({ searchQuery: q }); get().fetchAccounts(); },
  setJoinedDate: (date) => {
    set(state => ({ joinedDate: date, selectedIds: [], pagination: { ...state.pagination, page: 1 } }));
    get().fetchAccounts();
  },
  setPage: (page) => { set(s => ({ pagination: { ...s.pagination, page } })); get().fetchAccounts(); },
  setPageSize: (size) => { set(s => ({ pagination: { ...s.pagination, pageSize: size, page: 1 } })); get().fetchAccounts(); },
}));
