export interface ContextItem {
  file: string;
  lines: [number, number];
  score: number;
  why: string;
  tokens: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: any;
  }>;
  toolResults?: Array<{
    toolCallId: string;
    content: string;
  }>;
  chosenContext?: ContextItem[];
}

export interface ApprovalRequest {
  id: string;
  threadId: string;
  toolCalls: Array<{
    id: string;
    name?: string;
    arguments?: any;
  }>;
  summary?: string;
}

export interface ContextBudget {
  usedTokens: number;
  maxTokens: number;
}

export interface PanelState {
  model: string;
  status: 'idle' | 'streaming' | 'awaiting_approval' | 'error';
  budget: ContextBudget;
  messages: ChatMessage[];
  streamingChunk: string;
  activeApproval: ApprovalRequest | null;
  error: string | null;
}

export type PanelAction =
  | { type: 'SET_MODEL'; payload: string }
  | { type: 'START_STREAMING' }
  | { type: 'APPEND_STREAM_CHUNK'; payload: string }
  | { type: 'FINISH_STREAMING' }
  | { type: 'ADD_MESSAGE'; payload: ChatMessage }
  | { type: 'UPDATE_BUDGET'; payload: { usedTokens: number; maxTokens?: number } }
  | { type: 'SET_CHOSEN_CONTEXT'; payload: ContextItem[] }
  | { type: 'SET_APPROVAL_REQUEST'; payload: ApprovalRequest | null }
  | { type: 'RESOLVE_APPROVAL'; payload: { id: string; decision: 'allow' | 'deny' } }
  | { type: 'CLEAR_CHAT' }
  | { type: 'SET_ERROR'; payload: string | null };

export const initialPanelState: PanelState = {
  model: 'google-gemini/<primary-model-id>',
  status: 'idle',
  budget: {
    usedTokens: 0,
    maxTokens: 8000
  },
  messages: [],
  streamingChunk: '',
  activeApproval: null,
  error: null
};

export function panelReducer(state: PanelState = initialPanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case 'SET_MODEL':
      return {
        ...state,
        model: action.payload
      };

    case 'START_STREAMING':
      return {
        ...state,
        status: 'streaming',
        streamingChunk: '',
        error: null
      };

    case 'APPEND_STREAM_CHUNK':
      return {
        ...state,
        streamingChunk: state.streamingChunk + action.payload
      };

    case 'FINISH_STREAMING': {
      let updatedMessages = [...state.messages];
      if (state.streamingChunk) {
        // If last message is assistant without finished state, append or create assistant message
        const last = updatedMessages[updatedMessages.length - 1];
        if (last && last.role === 'assistant') {
          updatedMessages[updatedMessages.length - 1] = {
            ...last,
            content: last.content + state.streamingChunk
          };
        } else {
          updatedMessages.push({
            id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            role: 'assistant',
            content: state.streamingChunk,
            timestamp: Date.now()
          });
        }
      }

      return {
        ...state,
        status: state.activeApproval ? 'awaiting_approval' : 'idle',
        messages: updatedMessages,
        streamingChunk: ''
      };
    }

    case 'ADD_MESSAGE':
      return {
        ...state,
        messages: [...state.messages, action.payload]
      };

    case 'UPDATE_BUDGET':
      return {
        ...state,
        budget: {
          usedTokens: action.payload.usedTokens,
          maxTokens: action.payload.maxTokens ?? state.budget.maxTokens
        }
      };

    case 'SET_CHOSEN_CONTEXT': {
      const items = action.payload;
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = {
          ...last,
          chosenContext: items
        };
      } else {
        // Create placeholder assistant message or attach to last message
        msgs.push({
          id: `msg-${Date.now()}-ctx`,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          chosenContext: items
        });
      }
      return {
        ...state,
        messages: msgs
      };
    }

    case 'SET_APPROVAL_REQUEST':
      return {
        ...state,
        activeApproval: action.payload,
        status: action.payload ? 'awaiting_approval' : state.status === 'awaiting_approval' ? 'idle' : state.status
      };

    case 'RESOLVE_APPROVAL':
      return {
        ...state,
        activeApproval: null,
        status: 'idle'
      };

    case 'CLEAR_CHAT':
      return {
        ...state,
        status: 'idle',
        messages: [],
        streamingChunk: '',
        activeApproval: null,
        error: null,
        budget: {
          ...state.budget,
          usedTokens: 0
        }
      };

    case 'SET_ERROR':
      return {
        ...state,
        error: action.payload,
        status: action.payload ? 'error' : state.status === 'error' ? 'idle' : state.status
      };

    default:
      return state;
  }
}

