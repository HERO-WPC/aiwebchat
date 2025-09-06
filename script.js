// --- 全局变量定义 ---
const chatWindow = document.getElementById('chat-window');
const chatForm = document.getElementById('chat-form');
const messageInput = document.getElementById('message-input');
const modelSelect = document.getElementById('model-select');
const sendButton = chatForm.querySelector('button[type="submit"]');
const uploadButton = document.getElementById('upload-button');
const fileInput = document.getElementById('file-input');
const imagePreviewContainer = document.getElementById('image-preview-container');

// --- 应用状态管理 ---
let conversationHistory = [];
let attachedImageBase64 = null;

// --- 核心功能函数 ---

/**
 * 向聊天窗口添加一条消息。
 * @param {string} sender - 'user' 或 'assistant'。
 * @param {string} [text] - 消息的文本内容。
 * @param {string|null} [imageBase64] - 图片的 Base64 数据 URL。
 * @returns {HTMLElement} 返回新创建的消息元素。
 */
function addMessage(sender, text, imageBase64 = null) {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', sender);

    const contentElement = document.createElement('div');
    contentElement.classList.add('message-content');

    if (imageBase64) {
        const imageElement = document.createElement('img');
        imageElement.src = imageBase64;
        imageElement.alt = '用户上传的图片';
        imageElement.loading = 'lazy';
        contentElement.appendChild(imageElement);
    }

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
 * 在聊天窗口中显示一个“正在输入”的加载动画。
 * @returns {HTMLElement} 返回新创建的加载指示器元素。
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
 * 清除图片预览区域的内容，并重置相关的状态变量。
 */
function clearImagePreview() {
    imagePreviewContainer.innerHTML = '';
    attachedImageBase64 = null;
    fileInput.value = '';
}

/**
 * 处理 SSE (Server-Sent Events) 流式响应，逐块显示 AI 的回复。
 * @param {Response} response - fetch API 返回的响应对象。
 * @param {HTMLElement} typingIndicator - 之前显示的“正在输入”指示器元素。
 */
async function handleStreamedResponse(response, typingIndicator) {
    // 重要：确保此时 response 的 body 尚未被读取
    chatWindow.removeChild(typingIndicator);

    const reader = response.body.getReader(); // 读取原始 response 的 body
    const decoder = new TextDecoder('utf-8');
    let assistantMessageElement = null;
    let accumulatedContent = '';

    assistantMessageElement = addMessage('assistant', '');

    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            console.log("Stream finished.");
            break;
        }

        const chunk = decoder.decode(value, { stream: true });

        const lines = chunk.split('\n');
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const jsonStr = line.substring(6);
                if (jsonStr === '[DONE]') {
                    break;
                }
                try {
                    const data = JSON.parse(jsonStr);
                    let part = '';
                    if (data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content) {
                        part = data.choices[0].delta.content;
                    }
                    
                    if (part) {
                        accumulatedContent += part;
                        assistantMessageElement.querySelector('.message-content').textContent = accumulatedContent;
                        chatWindow.scrollTop = chatWindow.scrollHeight;
                    }
                } catch (e) {
                    console.error("Error parsing SSE JSON:", e, "Line:", jsonStr);
                    if (!accumulatedContent) {
                         assistantMessageElement.querySelector('.message-content').textContent = "接收到无效的流数据，请检查后端。";
                    }
                }
            } else if (line.trim() !== '') {
                console.warn("Unexpected line in SSE stream:", line);
            }
        }
    }

    if (accumulatedContent) {
        conversationHistory.push({ role: 'assistant', content: accumulatedContent });
    }
}


// --- 事件监听器设置 ---

uploadButton.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    
    if (file && file.type.startsWith('image/')) {
        const reader = new FileReader();
        
        reader.onload = (event) => {
            attachedImageBase64 = event.target.result;
            
            imagePreviewContainer.innerHTML = '';
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
    } else if (file) {
        alert('请选择一个图片文件！');
        fileInput.value = '';
    }
});

chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const userMessage = messageInput.value.trim();

    if (!userMessage && !attachedImageBase64) {
        console.log("没有输入文本或选择图片，取消发送。");
        return;
    }

    const selectedModel = modelSelect.value;
    addMessage('user', userMessage, attachedImageBase64);
    
    if (userMessage) {
        conversationHistory.push({ role: 'user', content: userMessage });
    } else if (attachedImageBase64) {
        conversationHistory.push({ role: 'user', content: "（用户发送了一张图片）" });
    }

    const typingIndicator = showTypingIndicator();
    const currentImageBase64 = attachedImageBase64;

    messageInput.value = '';
    clearImagePreview();
    sendButton.disabled = true;
    modelSelect.disabled = true;
    uploadButton.disabled = true;

    try {
        const fetchOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: selectedModel,
                messages: conversationHistory,
                image: currentImageBase64,
            }),
        };

        const response = await fetch('/api/chat', fetchOptions);

        // --- 核心修复：在检查 response.ok 之前克隆响应 ---
        // 克隆响应，以便可以在错误处理和正常流程中独立地读取其主体流。
        const clonedResponse = response.clone(); 

        // 如果服务器响应的 HTTP 状态码不是 2xx (不成功)
        if (!response.ok) {
            let errorMessage = 'API 请求失败';
            try {
                // *** 错误处理中只使用 clonedResponse ***
                const errorData = await clonedResponse.json(); 
                errorMessage = errorData.error || `API 错误: ${response.status} ${response.statusText}`;
            } catch (jsonError) {
                // 如果不是 JSON，尝试读取纯文本错误信息
                const errorText = await clonedResponse.text();
                errorMessage = `API 请求失败: ${response.status} ${response.statusText} - ${errorText.substring(0, 200)}...`;
                console.error("Error parsing API error response as JSON:", jsonError, "Raw text:", errorText);
            }
            // 抛出错误以进入 catch 块
            throw new Error(errorMessage); 
        }

        // --- 正常处理流程，使用原始 response ---
        // 检查原始 response 的 Content-Type 来判断是否是流式响应
        const contentType = response.headers.get('Content-Type');
        if (contentType && contentType.includes('text/event-stream')) {
            // 处理流式响应，直接使用原始 response
            await handleStreamedResponse(response, typingIndicator);
        } else {
            // 处理非流式（普通 JSON）响应，也使用原始 response
            // 注意：这里是唯一一次调用 response.json()，确保原始 body 只在此处被读取
            const data = await response.json(); 
            const assistantMessage = data.reply;

            if (assistantMessage) {
                conversationHistory.push({ role: 'assistant', content: assistantMessage });
                chatWindow.removeChild(typingIndicator);
                addMessage('assistant', assistantMessage);
            } else {
                console.warn('API 返回了空回复。');
                chatWindow.removeChild(typingIndicator);
                addMessage('assistant', '（AI没有返回具体内容）');
            }
        }

    } catch (error) {
        console.error('前端错误:', error);
        if (typingIndicator && chatWindow.contains(typingIndicator)) {
            chatWindow.removeChild(typingIndicator); 
        }
        addMessage('assistant', `抱歉，出错了: ${error.message}`);
    } finally {
        sendButton.disabled = false;
        modelSelect.disabled = false;
        uploadButton.disabled = false;
        messageInput.focus();
    }
});

document.addEventListener('DOMContentLoaded', () => {
    messageInput.focus();
    clearImagePreview();
    if (!modelSelect.value) {
        modelSelect.value = 'gemini';
        console.warn("模型选择器没有默认值，已设置为 'gemini'。");
    }
});
