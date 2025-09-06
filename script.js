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
 * @param {string} sender - 消息的发送者，'user' 或 'assistant'。
 * @param {string} [text] - (可选) 消息的文本内容。
 * @param {string|null} [imageBase64] - (可选) 要在消息中显示的图片的 Base64 数据 URL。
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
        contentElement.appendChild(imageElement);
    }

    if (text) {
        const textNode = document.createTextNode(text);
        contentElement.appendChild(textNode);
    }
    
    messageElement.appendChild(contentElement);
    chatWindow.appendChild(messageElement);
    
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return messageElement; // 返回消息元素以便后续更新（例如流式消息）
}

/**
 * 在聊天窗口中显示一个“正在输入”的加载动画。
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

// --- 事件监听器设置 ---

// 监听图片上传按钮的点击事件
uploadButton.addEventListener('click', () => {
    fileInput.click();
});

// 监听文件输入框的 'change' 事件
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
    }
});

// 监听表单的 'submit' 事件
chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const userMessage = messageInput.value.trim();

    if (!userMessage && !attachedImageBase64) {
        return;
    }

    const selectedModel = modelSelect.value;

    // 1. 乐观更新 UI：立即在界面上显示用户的消息
    addMessage('user', userMessage, attachedImageBase64);
    
    // 2. 更新对话历史：将用户的文本消息添加到历史记录中。
    conversationHistory.push({ role: 'user', content: userMessage });

    // 3. 准备发送 API 请求
    const typingIndicator = showTypingIndicator(); // 显示加载动画
    const currentImageBase64 = attachedImageBase64; // 临时保存当前要发送的图片数据

    // 4. 清理和禁用输入
    messageInput.value = '';
    clearImagePreview();
    sendButton.disabled = true;
    modelSelect.disabled = true;
    uploadButton.disabled = true;

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: selectedModel,
                messages: conversationHistory.slice(-5), // 仅发送最近5轮对话作为上下文
                image: currentImageBase64,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text(); // 尝试获取原始错误文本
            let errorData;
            try {
                errorData = JSON.parse(errorText); // 尝试解析为 JSON
            } catch (jsonError) {
                // 如果不是 JSON，使用原始文本
                errorData = { error: errorText };
            }
            throw new Error(errorData.error || `API 请求失败: ${response.status}`);
        }

        const contentType = response.headers.get('Content-Type');

        if (contentType && contentType.includes('text/event-stream')) {
            // --- 处理流式响应 (SSE) ---
            chatWindow.removeChild(typingIndicator); // 移除加载动画
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let accumulatedContent = ''; // 累积 AI 生成的内容
            
            // 创建 AI 消息的初始元素
            // 注意：这里我们只创建一个消息元素，然后不断更新它的textContent
            const assistantMessageElement = addMessage('assistant', ''); // 先添加一个空消息来占位

            let buffer = ''; // 用于处理不完整的 SSE 行

            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    console.log("Stream finished.");
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // 保留最后一行未完成的

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const sseData = line.substring(6).trim(); // 移除 "data: " 并去除前后空格
                        if (sseData === '[DONE]') {
                            console.log("SSE DONE signal received.");
                            // 流结束，将累积内容添加到消息历史
                            conversationHistory.push({ role: 'assistant', content: accumulatedContent });
                            reader.cancel(); // 告知 ReadableStream 应取消读取
                            return; // 结束处理
                        }
                        
                        try {
                            const json = JSON.parse(sseData);
                            // 根据模型解析不同的 SSE 内容
                            let currentChunkContent = '';
                            if (selectedModel === 'chatgpt' || selectedModel === 'deepseek') {
                                currentChunkContent = json.choices[0]?.delta?.content || '';
                            }
                            // 如果是 Gemini Stream (如果后端配置了)，格式可能不同
                            // if (selectedModel === 'gemini' && json.candidates && json.candidates[0]?.content?.parts[0]?.text) {
                            //    currentChunkContent = json.candidates[0].content.parts[0].text;
                            // }

                            if (currentChunkContent) {
                                accumulatedContent += currentChunkContent;
                                // 直接更新 assistantMessageElement 中的文本内容
                                assistantMessageElement.querySelector('.message-content').textContent = accumulatedContent; 
                                chatWindow.scrollTop = chatWindow.scrollHeight; // 滚动到底部
                            }

                        } catch (e) {
                            console.warn('Error parsing streamed JSON data chunk:', e, 'Raw data:', sseData);
                            // 有时非严格的 SSE 格式可能包含空的 data: 行或其他非 JSON 内容
                        }
                    } else if (line.trim() !== '') {
                         console.debug("Non-data line in SSE:", line.trim());
                    }
                }
            }

        } else {
            // --- 处理非流式响应 ---
            chatWindow.removeChild(typingIndicator); // 移除加载动画

            const data = await response.json();
            let replyContent = '';
            
            switch (selectedModel) {
                case 'gemini':
                    replyContent = data.candidates[0].content.parts[0].text;
                    break;
                case 'qwen':
                    replyContent = data.output.choices[0].message.content[0].text;
                    break;
                // chatgpt 和 deepseek 现在是流式，这些 case 不再被触发
            }

            // 显示 AI 消息
            addMessage('assistant', replyContent);
            // 将 AI 消息添加到历史中
            conversationHistory.push({ role: 'assistant', content: replyContent });
        }

    } catch (error) {
        console.error('发送或接收消息时出错:', error);
        if (typingIndicator && chatWindow.contains(typingIndicator)) {
            chatWindow.removeChild(typingIndicator); // 确保在错误时也移除加载动画
        }
        addMessage('assistant', `抱歉，出错了: ${error.message}`);
    } finally {
        sendButton.disabled = false;
        modelSelect.disabled = false;
        uploadButton.disabled = false;
        messageInput.focus();
    }
});

// 初始加载时的处理，例如清空聊天窗口
document.addEventListener('DOMContentLoaded', () => {
    chatWindow.innerHTML = ''; // 确保页面加载时聊天窗口是空的
});

