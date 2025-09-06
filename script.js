// --- DOM Element References ---
const chatWindow = document.getElementById('chat-window');
const chatForm = document.getElementById('chat-form');
const messageInput = document.getElementById('message-input');
const modelSelect = document.getElementById('model-select');
const sendButton = chatForm.querySelector('button[type="submit"]');
const uploadButton = document.getElementById('upload-button');
const fileInput = document.getElementById('file-input');
const imagePreviewContainer = document.getElementById('image-preview-container');

// --- State Management ---
let conversationHistory = [];
let attachedImageBase64 = null; // To store the base64 string of the attached image

// --- Core Functions ---

/**
 * Adds a message to the chat window. Can include text, an image, or both.
 * @param {string} sender - 'user' or 'assistant'.
 * @param {string} [text] - The text content of the message.
 * @param {string|null} [imageBase64] - The base64 string of the image to display.
 */
function addMessage(sender, text, imageBase64 = null) {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', sender);

    const contentElement = document.createElement('div');
    contentElement.classList.add('message-content');

    // Add image if it exists
    if (imageBase64) {
        const imageElement = document.createElement('img');
        imageElement.src = imageBase64;
        imageElement.alt = 'User uploaded image';
        contentElement.appendChild(imageElement);
    }

    // Add text if it exists
    if (text) {
        const textNode = document.createTextNode(text);
        contentElement.appendChild(textNode);
    }
    
    messageElement.appendChild(contentElement);
    chatWindow.appendChild(messageElement);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return messageElement;
}

/**
 * Shows a typing indicator in the chat window.
 */
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

/**
 * Clears the image preview and resets the image state.
 */
function clearImagePreview() {
    imagePreviewContainer.innerHTML = '';
    attachedImageBase64 = null;
    fileInput.value = ''; // Reset file input
}

// --- Event Listeners ---

// Trigger file input when upload button is clicked
uploadButton.addEventListener('click', () => {
    fileInput.click();
});

// Handle file selection
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file && file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (event) => {
            attachedImageBase64 = event.target.result;
            
            // Create preview
            imagePreviewContainer.innerHTML = ''; // Clear previous preview
            const previewWrapper = document.createElement('div');
            previewWrapper.className = 'image-preview-item';
            
            const previewImg = document.createElement('img');
            previewImg.src = attachedImageBase64;
            
            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-image-btn';
            removeBtn.innerHTML = '&times;';
            removeBtn.onclick = clearImagePreview;
            
            previewWrapper.appendChild(previewImg);
            previewWrapper.appendChild(removeBtn);
            imagePreviewContainer.appendChild(previewWrapper);
        };
        reader.readAsDataURL(file);
    }
});

// Handle form submission
chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const userMessage = messageInput.value.trim();

    // A message must contain either text or an image
    if (!userMessage && !attachedImageBase64) {
        return;
    }

    const selectedModel = modelSelect.value;

    // Add user message to UI
    addMessage('user', userMessage, attachedImageBase64);
    
    // Add user message to history (text part)
    // The image will be sent separately in the payload
    conversationHistory.push({ role: 'user', content: userMessage });

    // --- Prepare for API call ---
    const typingIndicator = showTypingIndicator();
    const currentImageBase64 = attachedImageBase64; // Capture the image for this message

    // Clear input fields and disable form
    messageInput.value = '';
    clearImagePreview();
    sendButton.disabled = true;
    modelSelect.disabled = true;
    uploadButton.disabled = true;

    try {
        // Send message and image to our Cloudflare Function
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: selectedModel,
                messages: conversationHistory,
                image: currentImageBase64, // Send the base64 image string
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
        
        // Display assistant's response
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
        uploadButton.disabled = false;
        messageInput.focus();
    }
});