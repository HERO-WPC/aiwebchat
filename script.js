// --- 全局变量定义 ---
// 通过 const 定义常量，保存对页面上重要 DOM 元素的引用。
// 这样做可以避免在函数中反复查询 DOM，提高性能。

const chatWindow = document.getElementById('chat-window'); // 聊天消息显示区域
const chatForm = document.getElementById('chat-form'); // 底部的表单
const messageInput = document.getElementById('message-input'); // 文本输入框
const modelSelect = document.getElementById('model-select'); // 模型选择下拉框
const sendButton = chatForm.querySelector('button[type="submit"]'); // 发送按钮
const uploadButton = document.getElementById('upload-button'); // 图片上传按钮
const fileInput = document.getElementById('file-input'); // 隐藏的文件选择框
const imagePreviewContainer = document.getElementById('image-preview-container'); // 图片预览区域

// --- 应用状态管理 ---
// 使用 let 定义变量，用于存储应用在运行过程中的状态。

let conversationHistory = []; // 存储整个对话历史记录，用于发送给 API 以维持上下文
let attachedImageBase64 = null; // 用于存储当前选中的、已编码为 Base64 的图片数据。发送后会清空。

// --- 核心功能函数 ---

/**
 * 向聊天窗口添加一条消息。这是一个非常核心的 UI 更新函数。
 * 它可以灵活处理只包含文本、只包含图片或图文混合的消息。
 * @param {string} sender - 消息的发送者，'user' 或 'assistant'。这个参数决定了消息气泡的样式和位置。
 * @param {string} [text] - (可选) 消息的文本内容。
 * @param {string|null} [imageBase64] - (可选) 要在消息中显示的图片的 Base64 数据 URL。
 * @returns {HTMLElement} 返回新创建的消息元素，方便后续操作（如移除加载动画）。
 */
function addMessage(sender, text, imageBase64 = null) {
    // 1. 创建消息的最外层容器 <div>
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', sender); // 添加 'message' 和发送者 ('user'/'assistant') 类名

    // 2. 创建消息内容的容器 <div>
    const contentElement = document.createElement('div');
    contentElement.classList.add('message-content');

    // 3. 如果存在图片数据，则创建并添加图片元素
    if (imageBase64) {
        const imageElement = document.createElement('img');
        imageElement.src = imageBase64; // Base64 数据可以直接作为图片的 src
        imageElement.alt = '用户上传的图片';
        imageElement.loading = 'lazy'; // 延迟加载图片，提高性能
        contentElement.appendChild(imageElement); // 将图片添加到内容容器中
    }

    // 4. 如果存在文本内容，则创建并添加文本节点
    // 使用 createTextNode 而不是 innerHTML 是为了防止 XSS (跨站脚本) 攻击，确保文本内容被当作纯文本处理。
    if (text) {
        const textNode = document.createTextNode(text);
        contentElement.appendChild(textNode); // 将文本添加到内容容器中
    }
    
    // 5. 组装并显示消息
    messageElement.appendChild(contentElement); // 将内容容器添加到消息外层容器
    chatWindow.appendChild(messageElement); // 将完整的消息元素添加到聊天窗口
    
    // 6. 自动滚动到聊天窗口的底部，确保最新的消息总是可见的
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return messageElement;
}

/**
 * 在聊天窗口中显示一个“正在输入”的加载动画。
 * 这能给用户一个即时的反馈，让他们知道应用正在处理他们的请求。
 * @returns {HTMLElement} 返回新创建的加载指示器元素。
 */
function showTypingIndicator() {
    const indicatorElement = document.createElement('div');
    indicatorElement.classList.add('message', 'assistant', 'loading'); // 使用和助手消息类似的样式
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
    return indicatorElement; // 返回这个元素的引用，方便之后移除它
}

/**
 * 清除图片预览区域的内容，并重置相关的状态变量。
 */
function clearImagePreview() {
    imagePreviewContainer.innerHTML = ''; // 清空预览区的 HTML
    attachedImageBase64 = null; // 重置 Base64 数据状态
    fileInput.value = ''; // 重置文件输入框的值。这很重要，否则用户无法连续选择同一张图片。
}

/**
 * 处理 SSE (Server-Sent Events) 流式响应，逐块显示 AI 的回复。
 * @param {Response} response - fetch API 返回的响应对象。
 * @param {HTMLElement} typingIndicator - 之前显示的“正在输入”指示器元素。
 */
async function handleStreamedResponse(response, typingIndicator) {
    chatWindow.removeChild(typingIndicator); // 移除加载动画

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let assistantMessageElement = null; // 用于存储 AI 消息的 DOM 元素
    let accumulatedContent = ''; // 累积 AI 返回的文本

    // 创建一个新的消息元素用于显示流式回复
    assistantMessageElement = addMessage('assistant', ''); // 先添加一个空文本的消息元素

    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            console.log("Stream finished.");
            break;
        }

        const chunk = decoder.decode(value, { stream: true });
        // console.log("Received chunk:", chunk); // 调试用

        // 这里需要针对不同模型的 SSE 格式进行解析
        // 以 OpenAI (chatgpt 和 deepseek) 为例，SSE 数据通常以 "data: " 开头
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
                    // 根据模型响应结构提取文本
                    if (data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content) {
                        part = data.choices[0].delta.content;
                    }
                    
                    if (part) {
                        accumulatedContent += part;
                        // 更新已存在的消息元素的内容
                        assistantMessageElement.querySelector('.message-content').textContent = accumulatedContent;
                        chatWindow.scrollTop = chatWindow.scrollHeight; // 保持滚动到底部
                    }
                } catch (e) {
                    console.error("Error parsing SSE JSON:", e, "Line:", jsonStr);
                }
            }
        }
    }

    // 将完整的 AI 回复添加到对话历史中
    if (accumulatedContent) {
        conversationHistory.push({ role: 'assistant', content: accumulatedContent });
    }
}


// --- 事件监听器设置 ---
// 这里我们将功能逻辑与用户的交互行为绑定起来。

// 监听图片上传按钮的点击事件
uploadButton.addEventListener('click', () => {
    // 当用户点击我们自定义的漂亮按钮时，我们以编程方式触发那个隐藏的、样式丑陋的文件输入框的点击事件。
    // 这是一个常见的前端技巧，用于自定义文件上传按钮的样式。
    fileInput.click();
});

// 监听文件输入框的 'change' 事件。当用户选择了文件后，这个事件就会被触发。
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0]; // 获取用户选择的第一个文件
    
    // 确保用户选择的是一个图片文件
    if (file && file.type.startsWith('image/')) {
        // FileReader 是一个浏览器提供的 API，用于异步读取文件内容。
        const reader = new FileReader();
        
        // 设置当文件读取完成时的回调函数
        reader.onload = (event) => {
            // event.target.result 包含了文件的 Base64 数据 URL
            attachedImageBase64 = event.target.result;
            
            // --- 创建并显示图片预览 ---
            imagePreviewContainer.innerHTML = ''; // 先清空之前的预览
            const previewWrapper = document.createElement('div');
            previewWrapper.className = 'image-preview-item';
            
            const previewImg = document.createElement('img');
            previewImg.src = attachedImageBase64;
            
            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-image-btn';
            removeBtn.innerHTML = '&times;'; // 显示一个 "×" 符号
            removeBtn.onclick = clearImagePreview; // 点击移除按钮时，调用清除函数
            
            previewWrapper.appendChild(previewImg);
            previewWrapper.appendChild(removeBtn);
            imagePreviewContainer.appendChild(previewWrapper);
        };
        
        // 启动文件读取过程。这会将整个图片文件编码成一个 Base64 字符串。
        reader.readAsDataURL(file);
    } else if (file) { // 如果用户选择了文件但不是图片
        alert('请选择一个图片文件！');
        fileInput.value = ''; // 清空文件输入框
    }
});

// 监听表单的 'submit' 事件。这是应用的核心交互逻辑。
chatForm.addEventListener('submit', async (e) => {
    e.preventDefault(); // <-- 核心修复：阻止表单的默认提交行为（即刷新页面）
    
    const userMessage = messageInput.value.trim(); // 获取输入框中的文本，并移除首尾空格

    // 验证：必须有文本或图片才能发送
    if (!userMessage && !attachedImageBase64) {
        return; // 如果两者都为空，则不执行任何操作
    }

    const selectedModel = modelSelect.value; // 获取当前选择的模型

    // 1. 乐观更新 UI：立即在界面上显示用户的消息，让用户感觉应用响应迅速。
    // 注意：我们将图片视为用户消息的一部分，在UI中立即显示。
    addMessage('user', userMessage, attachedImageBase64);
    
    // 2. 更新对话历史：将用户的文本消息添加到历史记录中。
    // 图片数据会作为单独的字段在请求体中发送，而不是直接混入历史记录。
    // 这里只添加纯文本到 `conversationHistory`，因为后端 `functions/api/chat.js` 会处理图像的特定格式。
    if (userMessage) {
        conversationHistory.push({ role: 'user', content: userMessage });
    } else if (attachedImageBase64) {
        // 如果只有图片没有文本，也需要给一个占位符，否则有些模型可能会有问题
        conversationHistory.push({ role: 'user', content: "用户发送了一张图片。" });
    }


    // 3. 准备发送 API 请求
    const typingIndicator = showTypingIndicator(); // 显示加载动画
    const currentImageBase64 = attachedImageBase64; // 临时保存当前要发送的图片数据

    // 4. 清理和禁用输入：在请求发送期间，清空输入框和预览，并禁用所有输入控件，防止用户重复发送。
    messageInput.value = '';
    clearImagePreview();
    sendButton.disabled = true;
    modelSelect.disabled = true;
    uploadButton.disabled = true;

    // 5. 使用 try...catch...finally 结构来健壮地处理异步 API 请求
    try {
        // 发送网络请求到我们的后端 API 代理 (Cloudflare Function)
        const response = await fetch('/api/chat', { // 注意这里的路径 '/api/chat' 假设你的 Cloudflare Worker 路由是这样设置的
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // 构建发送到后端的 JSON 数据体
            body: JSON.stringify({
                model: selectedModel,
                messages: conversationHistory,
                image: currentImageBase64, // 将捕获的图片数据包含在请求中
            }),
        });

        // 如果服务器响应的 HTTP 状态码不是 2xx (不成功)
        if (!response.ok) {
            // 尝试解析错误信息，确保错误处理足够健壮
            let errorMessage = 'API 请求失败';
            try {
                const errorData = await response.json();
                errorMessage = errorData.error || errorMessage;
            } catch (jsonError) {
                const errorText = await response.text();
                errorMessage = `API 请求失败: ${errorText.substring(0, 100)}`; // 截断避免过长
            }
            throw new Error(errorMessage); // 抛出一个错误，会被下面的 catch 捕获
        }

        // 根据响应头的 Content-Type 来判断是否是流式响应
        const contentType = response.headers.get('Content-Type');
        if (contentType && contentType.includes('text/event-stream')) {
            // 处理流式响应
            await handleStreamedResponse(response, typingIndicator);
        } else {
            // 处理非流式（普通 JSON）响应
            const data = await response.json(); // 解析成功的 JSON 响应
            const assistantMessage = data.reply; // 提取 AI 的回复文本

            // 6. 更新状态和 UI：将 AI 的回复也添加到对话历史中
            if (assistantMessage) { // 确保有内容才添加到历史和UI
                conversationHistory.push({ role: 'assistant', content: assistantMessage });
                chatWindow.removeChild(typingIndicator); // 先移除加载动画
                addMessage('assistant', assistantMessage); // 再显示 AI 的消息
            } else {
                console.warn('API 返回了空回复。');
                chatWindow.removeChild(typingIndicator);
                addMessage('assistant', '（AI没有返回具体内容）');
            }
        }

    } catch (error) {
        // 如果在 try 块中发生任何错误（网络问题、API 失败等），代码会跳转到这里
        console.error('前端错误:', error); // 在浏览器控制台打印详细错误，方便调试
        if (typingIndicator && chatWindow.contains(typingIndicator)) {
            chatWindow.removeChild(typingIndicator); // 同样要移除加载动画
        }
        addMessage('assistant', `抱歉，出错了: ${error.message}`); // 在界面上向用户显示一个友好的错误提示
    } finally {
        // 无论请求成功还是失败，finally 块中的代码都一定会执行
        // 8. 恢复界面：重新启用输入控件，让用户可以开始下一次对话
        sendButton.disabled = false;
        modelSelect.disabled = false;
        uploadButton.disabled = false;
        messageInput.focus(); // 将光标自动聚焦到输入框，方便用户继续输入
    }
});

// 在页面加载完成后将光标聚焦到输入框
document.addEventListener('DOMContentLoaded', () => {
    messageInput.focus();
    // 初始清空图片预览，以防浏览器缓存
    clearImagePreview(); 
});

