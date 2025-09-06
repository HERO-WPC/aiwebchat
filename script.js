const chatWindow = document.getElementById('chat-window');
const chatForm = document.getElementById('chat-form');
const messageInput = document.getElementById('message-input');
const modelSelect = document.getElementById('model-select');
const sendButton = chatForm.querySelector('button');

// Store conversation history
let conversationHistory = [];

// Function to add a message to the chat window
function addMessage(sender, text) {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', sender);

    const contentElement = document.createElement('div');
    contentElement.classList.add('message-content');
    
    // Sanitize text to prevent HTML injection
    const textNode = document.createTextNode(text);
    contentElement.appendChild(textNode);
    
    messageElement.appendChild(contentElement);
    chatWindow.appendChild(messageElement);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return messageElement;
}

// Function to show typing indicator
function showTypingIndicator() {
    const indicatorElement = document.createElement('div');
    indicatorElement.classList.add('message', 'assistant', 'loading');
    indicatorElement.innerHTML = `
        <div class="message-content">
            <div class="typing-indicator">
                <span></span>
                <span></span>
                <span></span>
            </div>
        </div>
    `;
    chatWindow.appendChild(indicatorElement);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return indicatorElement;
}

// Handle form submission
chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const userMessage = messageInput.value.trim();
    if (!userMessage) return;

    const selectedModel = modelSelect.value;

    // Add user message to UI and history
    addMessage('user', userMessage);
    conversationHistory.push({ role: 'user', content: userMessage });

    // Clear input and disable form
    messageInput.value = '';
    sendButton.disabled = true;
    modelSelect.disabled = true;

    const typingIndicator = showTypingIndicator();

    try {
        // Send message to our Cloudflare Function backend
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: selectedModel,
                messages: conversationHistory,
            }),
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'API request failed');
        }

        const data = await response.json();
        const assistantMessage = data.reply;

        // Add assistant message to history
        conversationHistory.push({ role: 'assistant', content: assistantMessage });
        
        // Remove typing indicator and add the actual message
        chatWindow.removeChild(typingIndicator);
        addMessage('assistant', assistantMessage);

    } catch (error) {
        console.error('Error:', error);
        chatWindow.removeChild(typingIndicator);
        addMessage('assistant', `Error: ${error.message}`);
    } finally {
        // Re-enable form
        sendButton.disabled = false;
        modelSelect.disabled = false;
        messageInput.focus();
    }
});
