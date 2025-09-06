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

    const contentElement = document.createElement('div'); // 消息内容的容器
    contentElement.classList.add('message-content');

    if (imageBase64) {
        const imageElement = document.createElement('img');
        imageElement.src = imageBase64;
        imageElement.alt = '用户上传的图片';
        imageElement.loading = 'lazy';
        contentElement.appendChild(imageElement);
    }

    if (text) {
        // 使用 innerHTML 处理文本，并确保转义以防止 XSS
        // 因为一些模型可能会返回 Markdown 格式的文本，createTextNode 不会解释它。
        // 这里只是一个简单的处理，如果需要更复杂的 Markdown 渲染，需要引入第三方库。
        contentElement.innerHTML += DOMPurify.sanitize(marked.parse(text)); // 假设引入了 marked 和 DOMPurify
    } else if (!imageBase64) { // 如果既没文本也没图片，给个占位符
        contentElement.textContent = ''; 
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
 * 这个函数只会操作 `response.body.getReader()`
 * @param {Response} streamedResponse - fetch API 返回的原始响应对象，其 body 将被读取为流。
 * @param {HTMLElement} typingIndicator - 之前显示的“正在输入”指示器元素。
 */
async function handleStreamedResponse(streamedResponse, typingIndicator) {
    console.log("Entering handleStreamedResponse.");
    if (chatWindow.contains(typingIndicator)) {
        chatWindow.removeChild(typingIndicator); // 移除加载动画
    }

    const reader = streamedResponse.body.getReader(); 
    const decoder = new TextDecoder('utf-8');
    let assistantMessageElement = addMessage('assistant', ''); // 先添加一个空文本的消息元素
    let accumulatedContent = '';

    try {
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
                            // 实时更新消息元素的内容
                            const msgContent = assistantMessageElement.querySelector('.message-content');
                            msgContent.innerHTML = DOMPurify.sanitize(marked.parse(accumulatedContent));
                            chatWindow.scrollTop = chatWindow.scrollHeight;
                        }
                    } catch (e) {
                        console.error("Error parsing SSE JSON:", e, "Line:", jsonStr);
                        if (!accumulatedContent) { 
                             assistantMessageElement.querySelector('.message-content').textContent = "（接收到无效的流数据，请检查后端。）";
                        }
                    }
                } else if (line.trim() !== '') { 
                    console.warn("Unexpected line in SSE stream:", line);
                }
            }
        }
    } catch (streamError) {
        console.error("Error while reading stream:", streamError);
        const currentContent = assistantMessageElement.querySelector('.message-content').textContent;
        // 避免重复添加错误信息
        if (!currentContent.includes('[流读取错误]')) {
             assistantMessageElement.querySelector('.message-content').textContent += `\n[流读取错误: ${streamError.message}]`;
        }
    } finally {
        if (accumulatedContent) {
            conversationHistory.push({ role: 'assistant', content: accumulatedContent });
        } else {
            // 如果流结束但没有内容，且没有错误消息，可以添加一个默认提示
            if (!assistantMessageElement.querySelector('.message-content').textContent.includes('错误')) {
                assistantMessageElement.querySelector('.message-content').textContent = "（AI没有返回具体内容或流提前结束）";
            }
        }
        console.log("Exiting handleStreamedResponse.");
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
    
    const messageForHistory = userMessage || "（用户发送了一张图片）"; // 确保历史记录中总有内容
    conversationHistory.push({ role: 'user', content: messageForHistory });

    const typingIndicator = showTypingIndicator();
    const currentImageBase64 = attachedImageBase64;

    messageInput.value = '';
    clearImagePreview();
    sendButton.disabled = true;
    modelSelect.disabled = true;
    uploadButton.disabled = true;

    try {
        console.log("Sending API request to /api/chat...");
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
        console.log("Received raw response. Status:", response.status, response.statusText);

        // 克隆响应，用于**可能**的错误处理。原始响应用于正常流程。
        const clonedResponseForError = response.clone(); 
        console.log("Response cloned.");

        // 首先检查响应是否成功 (HTTP 状态码 2xx)
        if (!response.ok) {
            let errorMessage = `API 请求失败：HTTP ${response.status} ${response.statusText}`;
            console.error(errorMessage);
            try {
                // 尝试从克隆的响应中解析 JSON 错误信息
                const errorData = await clonedResponseForError.json(); 
                errorMessage += ` - ${errorData.error || JSON.stringify(errorData)}`;
                console.error("Parsed error data from cloned response:", errorData);
            } catch (jsonError) {
                // 如果不是 JSON，则尝试读取纯文本错误信息
                console.warn("Failed to parse error response as JSON, attempting to read as text.", jsonError);
                try {
                    const errorText = await clonedResponseForError.text();
                    errorMessage += ` - ${errorText.substring(0, 200)}...`; // 截断避免过长
                    console.error("Read error response as text from cloned response:", errorText);
                } catch (textError) {
                    console.error("Failed to read error response even as text:", textError);
                    errorMessage += " - 无法读取详细错误信息。";
                }
            }
            throw new Error(errorMessage); // 抛出错误，会被 catch 块捕获
        }

        // 走到这里说明 response.ok 为 true，现在处理正常响应。
        const contentType = response.headers.get('Content-Type');
        console.log("Original Response Content-Type:", contentType);

        if (contentType && contentType.includes('text/event-stream')) {
            console.log("Detected SSE stream. Handling streamed response...");
            await handleStreamedResponse(response, typingIndicator);
        } 
        // 考虑后端可能返回 'application/json' 甚至 'text/plain'
        else if (contentType && contentType.includes('application/json')) {
            console.log("Detected JSON response. Handling as non-streamed...");
            const data = await response.json(); // 在这里读取原始响应体一次
            const assistantMessage = data.reply;
            console.log("Parsed JSON response data:", data);

            if (assistantMessage) {
                conversationHistory.push({ role: 'assistant', content: assistantMessage });
                chatWindow.removeChild(typingIndicator);
                addMessage('assistant', assistantMessage);
            } else {
                console.warn('API 返回了空回复，但状态码为 2xx。');
                chatWindow.removeChild(typingIndicator);
                addMessage('assistant', '（AI没有返回具体内容，请检查后端。）');
            }
        } 
        else {
            // 未知 Content-Type 或普通文本响应
            console.warn(`Unknown or unexpected Content-Type: ${contentType}. Trying to read as text.`);
             const rawText = await response.text(); // 尝试读取原始响应体一次
             chatWindow.removeChild(typingIndicator);
             addMessage('assistant', `后端返回了未知格式的数据。原始内容：<pre>${DOMPurify.sanitize(rawText.substring(0, 500))}</pre>`);
             console.error("Unknown response format. Raw text:", rawText);
        }

    } catch (error) {
        console.error('前端请求过程中发生错误:', error);
        // 确保加载动画在错误发生时被移除
        if (typingIndicator && chatWindow.contains(typingIndicator)) {
            chatWindow.removeChild(typingIndicator); 
        }
        addMessage('assistant', `抱歉，出错了: ${error.message}`);
    } finally {
        console.log("Request processing finished. Re-enabling inputs.");
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
    // 增加一个检查，确保 marked 和 DOMPurify 已加载
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
        console.warn('marked.js 或 DOMPurify.js 未加载。消息将作为纯文本处理。');
        addMessage('assistant', '警告：marked.js 或 DOMPurify.js 库未加载，聊天消息将作为纯文本显示，不进行 Markdown 渲染和 XSS 过滤。');
    }
});
