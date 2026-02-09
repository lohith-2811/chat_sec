import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';

// --- CONFIGURATION ---
const BACKEND_URL = 'http://localhost:5000'; 
const LONG_PRESS_DURATION = 500; // ms for long press detection

let tempMessageIdCounter = 0; 

// --- SIMULATED E2EE FUNCTIONS (NON-SECURE) ---
const encryptMessage = (messageObject) => {
  const jsonString = JSON.stringify(messageObject);
  const encryptedData = btoa(jsonString); 
  return {
    iv: 'fakeIV',
    data: encryptedData
  };
};

const decryptPayload = (payload) => {
  try {
    const jsonString = atob(payload.data);
    return JSON.parse(jsonString);
  } catch (e) {
    console.error("Decryption/Parsing Failed:", e);
    return { type: 'text', content: '*** ERROR: Could not decrypt message. ***' };
  }
};

// --- REACT COMPONENT ---

const ChatClient = () => {
  const [roomIdInput, setRoomIdInput] = useState('');
  const [roomId, setRoomId] = useState(null);
  const [messageInput, setMessageInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessages, setSelectedMessages] = useState(new Set());
  
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);
  const pressTimerRef = useRef(null);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, selectionMode]);

  // --- SOCKET LISTENERS ---

  const handleIncomingMessage = useCallback((msg) => {
    setMessages(prevMessages => {
        // FIX: Match based on tempId returned from server
        // This is much faster and more reliable than comparing image content
        if (msg.tempId) {
            const existingTempIndex = prevMessages.findIndex(m => m._id === msg.tempId);
            
            if (existingTempIndex !== -1) {
                // Sender: Replace temp message with real DB message
                const newMessages = [...prevMessages];
                newMessages[existingTempIndex] = { ...msg, isSender: true };
                return newMessages;
            }
        }

        // Receiver (or Sender fallback): Check if we already have this ID to prevent duplicates
        const alreadyExists = prevMessages.some(m => m._id === msg._id);
        if (alreadyExists) return prevMessages;

        // New message from another user
        return [...prevMessages, { ...msg, isSender: false }];
    });
  }, []);

  const handlePreviousMessages = useCallback((prevMessages) => {
    const formattedMessages = prevMessages.map(msg => ({ ...msg, isSender: false }));
    setMessages(formattedMessages);
  }, []); 

  const handleMessagesDeleted = useCallback(({ messageIds }) => {
    setMessages(prevMessages => 
      prevMessages.filter(msg => !messageIds.includes(msg._id))
    );
    setSelectionMode(false);
    setSelectedMessages(new Set());
  }, []);

  // --- SOCKET SETUP EFFECT ---
  useEffect(() => {
    const socket = io(BACKEND_URL);
    socketRef.current = socket;

    socket.on("connect", () => console.log("Connected to server."));
    socket.on("previous-messages", handlePreviousMessages);
    socket.on("receive-message", handleIncomingMessage);
    socket.on("messages-deleted", handleMessagesDeleted);

    return () => {
      socket.off("previous-messages");
      socket.off("receive-message");
      socket.off("messages-deleted");
      socket.disconnect();
    };
  }, [handlePreviousMessages, handleIncomingMessage, handleMessagesDeleted]);

  // --- USER ACTIONS ---

  const joinRoom = () => {
    const trimmedId = roomIdInput.trim();
    if (!trimmedId || !socketRef.current) return;

    setMessages([]);
    setRoomId(trimmedId);
    socketRef.current.emit("join-room", trimmedId);
  };

  const sendMessage = (type, content) => {
    if (!roomId || !socketRef.current || !content) return;

    const messageObject = { type, content };
    const payload = encryptMessage(messageObject);
    const tempId = `temp_${Date.now()}_${tempMessageIdCounter++}`; // More unique ID

    // Update local state with a temporary ID for immediate display
    setMessages(prevMessages => [...prevMessages, { 
        payload, 
        isSender: true, 
        _id: tempId, 
    }]);

    // Emit to server (passing tempId so server can return it)
    socketRef.current.emit("send-message", { roomId, payload, tempId });
  };

  const handleTextSend = (e) => {
    e.preventDefault();
    const content = messageInput.trim();
    if (!content) return;

    sendMessage('text', content);
    setMessageInput('');
  };

  const handleDelete = () => {
    if (selectedMessages.size === 0 || !socketRef.current || !roomId) return;

    const messageIds = Array.from(selectedMessages).filter(id => !id.toString().startsWith('temp_'));

    if (messageIds.length !== selectedMessages.size) {
        alert("Cannot delete messages that are still pending/sending. Please wait.");
        return;
    }
    
    const confirmDelete = window.confirm(`Are you sure you want to delete ${messageIds.length} message(s) permanently?`);
    
    if (confirmDelete) {
      socketRef.current.emit("delete-messages", { roomId, messageIds });
    }
  };

  // --- UI/UX LOGIC (Long Press and Selection) ---

  const startPressTimer = (messageId) => {
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);

    pressTimerRef.current = setTimeout(() => {
      if (!selectionMode) {
        setSelectionMode(true);
      }
      toggleSelection(messageId);
    }, LONG_PRESS_DURATION);
  };

  const clearPressTimer = () => {
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
  };

  const handleMessageClick = (messageId) => {
    clearPressTimer(); 

    if (selectionMode) {
      toggleSelection(messageId);
    }
  };
  
  const toggleSelection = (messageId) => {
    setSelectedMessages(prevSelected => {
      const newSet = new Set(prevSelected);
      if (newSet.has(messageId)) {
        newSet.delete(messageId);
      } else {
        newSet.add(messageId);
      }
      
      if (newSet.size === 0) {
        setSelectionMode(false);
      }
      return newSet;
    });
  };

  const handleImageUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    // Increased client-side check to match server capability roughly
    if (file.size > 10 * 1024 * 1024) { 
        alert("Image file is too large (max 10MB recommended).");
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        const base64Content = e.target.result;
        sendMessage('image', base64Content);
    };
    reader.readAsDataURL(file);
    event.target.value = null; 
  };

  // --- RENDERING HELPERS ---

  const renderMessage = (msg) => {
    const messageId = msg._id; 
    if (!messageId) return null;

    const { type, content } = decryptPayload(msg.payload);
    const isSelected = selectedMessages.has(messageId);
    const isSending = messageId.toString().startsWith('temp_'); 

    return (
      <div 
        key={messageId} 
        style={messageContainerStyle(msg.isSender)}
      >
        {selectionMode && (
          <div 
            style={selectionIndicatorStyle(isSelected, msg.isSender)}
            onClick={() => handleMessageClick(messageId)}
          >
            {isSelected ? '✓' : ''}
          </div>
        )}
        
        <div 
          style={messageStyle(msg.isSender, isSelected)}
          onMouseDown={() => startPressTimer(messageId)}
          onMouseUp={() => handleMessageClick(messageId)}
          onMouseLeave={clearPressTimer}
          onTouchStart={() => startPressTimer(messageId)}
          onTouchEnd={() => handleMessageClick(messageId)}
        >
          {isSending && <span style={{fontSize: '10px', color: '#666', display: 'block'}}>...sending</span>}
          {type === 'image' 
            ? <img src={content} alt="Shared Content" style={imageStyle} />
            : <div>{content}</div>
          }
        </div>
      </div>
    );
  };

  // --- UI RENDERING ---

  if (!roomId) {
    return (
        <div style={setupStyle}>
            <h2>Join Secure Chat Room</h2>
            <input 
            type="text" 
            value={roomIdInput}
            onChange={(e) => setRoomIdInput(e.target.value)}
            placeholder="Enter Room ID (e.g., SecureChat)"
            style={inputStyle}
            />
            <button onClick={joinRoom} style={buttonStyle}>Join</button>
        </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={infoBarStyle}>
        {selectionMode 
            ? <span onClick={() => setSelectionMode(false)} style={{cursor: 'pointer', marginRight: '10px', fontWeight: 'normal'}}>Exit Selection (X)</span>
            : `Room: ${roomId} (E2EE Active)`
        }
      </div>
      <div id="messages" style={messagesContainerStyle}>
        {messages.map((msg) => renderMessage(msg))}
        <div ref={messagesEndRef} />
      </div>
      <form onSubmit={handleTextSend} style={inputAreaStyle}>
        {selectionMode ? (
            <button 
                type="button" 
                onClick={handleDelete} 
                style={deleteButtonStyle(selectedMessages.size > 0)}
                disabled={selectedMessages.size === 0}
            >
                Delete ({selectedMessages.size})
            </button>
        ) : (
            <>
                <input 
                type="file" 
                id="image-upload" 
                accept="image/*" 
                onChange={handleImageUpload}
                style={{ display: 'none' }} 
                />
                <button 
                    type="button" 
                    onClick={() => document.getElementById('image-upload').click()} 
                    style={{...sendButtonStyle, marginLeft: '0px', marginRight: '5px'}}
                >
                    🖼️
                </button>
                <input 
                type="text" 
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                placeholder="Type an encrypted message..."
                style={messageInputStyle}
                />
                <button type="submit" style={sendButtonStyle}>Send</button>
            </>
        )}
      </form>
    </div>
  );
};

export default ChatClient;

// --- STYLES (Inline for simplicity) ---

const containerStyle = {
    width: '100%', maxWidth: '600px', height: '80vh', 
    background: 'white', boxShadow: '0 0 10px rgba(0,0,0,0.1)', 
    display: 'flex', flexDirection: 'column', borderRadius: '8px', overflow: 'hidden'
};

const setupStyle = {
    padding: '20px', background: '#fff', borderRadius: '8px', boxShadow: '0 0 10px rgba(0,0,0,0.1)'
};

const inputStyle = { padding: '10px', marginRight: '10px', borderRadius: '5px', border: '1px solid #ccc' };
const buttonStyle = { padding: '10px 15px', border: 'none', borderRadius: '5px', cursor: 'pointer', background: '#075e54', color: 'white' };

const infoBarStyle = { padding: '10px', background: '#34b7f1', color: 'white', textAlign: 'center', fontWeight: 'bold' };

const messagesContainerStyle = { flexGrow: '1', padding: '10px', overflowY: 'auto', background: '#e5ddd5' };

const messageContainerStyle = (isSender) => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: isSender ? 'flex-end' : 'flex-start',
    marginBottom: '8px',
});

const selectionIndicatorStyle = (isSelected, isSender) => ({
    order: isSender ? 1 : 0, 
    width: '20px',
    height: '20px',
    borderRadius: '50%',
    border: '2px solid #075e54',
    backgroundColor: isSelected ? '#075e54' : 'transparent',
    color: 'white',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    margin: isSender ? '0 0 0 5px' : '0 5px 0 0',
    fontSize: '14px',
    fontWeight: 'bold',
    cursor: 'pointer',
    flexShrink: 0,
});

const messageStyle = (isSender, isSelected) => ({
    padding: '8px 12px', 
    borderRadius: '12px', 
    maxWidth: '80%', 
    wordWrap: 'break-word',
    background: isSender ? '#dcf8c6' : '#fff', 
    boxShadow: isSelected ? '0 0 5px 3px rgba(255,0,0,0.5)' : 'none', 
    cursor: 'pointer',
    position: 'relative',
});

const imageStyle = { maxWidth: '100%', height: 'auto', display: 'block', marginTop: '5px', borderRadius: '6px' };

const inputAreaStyle = { display: 'flex', padding: '10px', borderTop: '1px solid #eee' };

const messageInputStyle = { flexGrow: '1', padding: '10px', border: '1px solid #ccc', borderRadius: '20px', marginRight: '10px' };

const sendButtonStyle = { padding: '10px 15px', border: 'none', borderRadius: '20px', cursor: 'pointer', background: '#075e54', color: 'white' };

const deleteButtonStyle = (isEnabled) => ({
    padding: '10px 15px', 
    border: 'none', 
    borderRadius: '20px', 
    cursor: isEnabled ? 'pointer' : 'not-allowed', 
    background: isEnabled ? 'red' : '#cccccc', 
    color: 'white',
    flexGrow: 1,
});
