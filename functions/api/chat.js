/**
 * 这是在 Cloudflare Functions 上运行的后端 API 代理。
 * 它的核心职责有三个：
 * 1. 安全性：作为前端和各大模型 API 之间的中间层，隐藏并保护您的 API 密钥。密钥存储在 Cloudflare 的环境变量中，绝不会暴露给前端。
 * 2. 统一性：为前端提供一个统一的、简单的 API 接口 (`/api/chat`)。无论前端选择哪个模型，都只与这个接口通信。
 * 3. 适配性：将前端发来的统一格式的数据，转换成各个大模型 API 所要求的、各不相同的特定格式。
 */

// Cloudflare Functions 的入口点。每个发往此路由的 POST 请求都会触发这个函数。
export async function onRequestPost(context) {
    try {
        // `context` 对象包含了请求的所有信息。
        // `request` 是浏览器发来的请求对象。
        // `env` 是一个包含了您在 Cloudflare 后台设置的所有环境变量（如 API 密钥）的对象。
        const { request, env } = context;

        // 从请求的 JSON 体中解析出前端发送的数据。
        // `image` 字段可能存在也可能不存在。
        const { model, messages, image } = await request.json();

        /**
         * 辅助函数：用于从 Base64 数据 URL 中解析出 MIME 类型和纯 Base64 数据。
         * 例如，从 "data:image/png;base64,iVBORw0KGgo..." 中提取出 "image/png" 和 "iVBORw0KGgo..."
         * @param {string} base64String - 完整的数据 URL。
         * @returns {{mimeType: string|null, data: string|null}}
         */
        const parseBase64 = (base64String) => {
            const match = base64String.match(/^data:(image\/.+);base64,(.+)$/);
            if (!match) return { mimeType: null, data: null };
            return { mimeType: match[1], data: match[2] };
        };

        let apiRequest; // 这个变量将用于存储最终构建好的、要发送给目标 API 的请求对象。

        // 如果前端发送了图片，就解析它；否则，mimeType 和 imageData 都为 null。
        const { mimeType, data: imageData } = image ? parseBase64(image) : { mimeType: null, data: null };

        // 获取最后一条用户消息的文本内容，这在某些模型的请求构建中会用到。
        const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || '';

        // --- 模型适配层 ---
        // 这是此后端服务的核心逻辑。根据前端选择的模型，构建不同的 API 请求。
        switch (model) {
            case 'gemini':
                const geminiApiKey = env.GEMINI_API_KEY;
                if (!geminiApiKey) throw new Error("GEMINI_API_KEY 环境变量未设置");

                // Gemini 的 API 格式要求将角色从 'assistant' 映射到 'model'。
                const geminiContents = messages.map(msg => ({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: msg.content }] // 每个消息的内容都放在一个 parts 数组里
                }));

                // 如果有图片，需要将图片数据作为另一个 "part" 添加到最后一条用户消息中。
                if (imageData) {
                    const lastUserContent = geminiContents.filter(c => c.role === 'user').pop();
                    if (lastUserContent) {
                        lastUserContent.parts.push({
                            inline_data: { mime_type: mimeType, data: imageData }
                        });
                    }
                }

                apiRequest = {
                    url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: geminiContents })
                };
                break;

            case 'chatgpt':
                const openaiApiKey = env.OPENAI_API_KEY; // 依然使用 ChatAnywhere 的 API Key
                if (!openaiApiKey) throw new Error("OPENAI_API_KEY 环境变量未设置");

                let finalMessagesChatgpt = []; // 使用 let 并重命名以避免冲突

                // 添加系统消息（可选，用于设定AI的行为）
                finalMessagesChatgpt.push({ role: 'system', content: '你是一个乐于助人的AI助手。' });

                // 添加历史对话（如果存在）
                if (messages && messages.length > 0) {
                    messages.forEach((msg, index) => {
                        // 假设除了最后一条，其余消息都是纯文本
                        // 如果您的历史消息也可能包含图片，则需要更复杂的判断
                        if (index < messages.length - 1) { // 除了最后一条消息
                            finalMessagesChatgpt.push({
                                role: msg.role,
                                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                            });
                        }
                    });
                }

                // 处理当前的用户输入，包括可能的图片
                const currentUserMessageChatgpt = messages[messages.length - 1]; // 使用 let 并重命名以避免冲突
                if (currentUserMessageChatgpt) {
                    if (imageData && image) {
                        // 多模态消息
                        finalMessagesChatgpt.push({
                            role: 'user',
                            content: [
                                { type: 'text', text: typeof currentUserMessageChatgpt.content === 'string' ? currentUserMessageChatgpt.content : '' }, // 文本部分
                                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageData}` } } // 使用 mimeType
                            ]
                        });
                    } else {
                        // 纯文本消息
                        finalMessagesChatgpt.push({
                            role: 'user',
                            content: typeof currentUserMessageChatgpt.content === 'string' ? currentUserMessageChatgpt.content : JSON.stringify(currentUserMessageChatgpt.content)
                        });
                    }
                }

                const chatanywhereApiHostChatgpt = 'https://api.chatanywhere.tech'; // 国内使用 // 使用 let 并重命名以避免冲突
                // const chatanywhereApiHostChatgpt = 'https://api.chatanywhere.org'; // 国外使用

                apiRequest = {
                    url: `${chatanywhereApiHostChatgpt}/v1/chat/completions`, // 注意：改变了 API 端点
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${openaiApiKey}`
                    },
                    body: JSON.stringify({
                        model: "gpt-4o", // 推荐使用 Chat Completions API 中的更强大模型，例如 gpt-4o 或 gpt-4-turbo
                        // ChatAnywhere 文档中提到了 'gpt-4o-ca' 和 'gpt-4-turbo-ca'
                        // 您可以尝试 'gpt-4o' 或 ChatAnywhere 提供的 CA 系列模型
                        messages: finalMessagesChatgpt, // 使用 messages 数组
                        stream: true // 如果您希望流式传输响应，可以设置此项
                    })
                };
                break;


            case 'deepseek':
                const deepseekApiKey = env.DEEPSEEK_API_KEY; // 依然使用 ChatAnywhere 的 API Key
                if (!deepseekApiKey) throw new Error("DEEPSEEK_API_KEY 环境变量未设置"); // 修正环境变量名

                let finalMessagesDeepseek = []; // 使用 let 并重命名以避免冲突

                // 添加系统消息（可选，用于设定AI的行为）
                finalMessagesDeepseek.push({ role: 'system', content: '你是一个乐于助人的AI助手。' });

                // 添加历史对话（如果存在）
                if (messages && messages.length > 0) {
                    messages.forEach((msg, index) => {
                        // 假设除了最后一条，其余消息都是纯文本
                        // 如果您的历史消息也可能包含图片，则需要更复杂的判断
                        if (index < messages.length - 1) { // 除了最后一条消息
                            finalMessagesDeepseek.push({
                                role: msg.role,
                                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                            });
                        }
                    });
                }

                // 处理当前的用户输入，包括可能的图片
                const currentUserMessageDeepseek = messages[messages.length - 1]; // 使用 let 并重命名以避免冲突
                if (currentUserMessageDeepseek) {
                    if (imageData && image) {
                        // 多模态消息
                        finalMessagesDeepseek.push({
                            role: 'user',
                            content: [
                                { type: 'text', text: typeof currentUserMessageDeepseek.content === 'string' ? currentUserMessageDeepseek.content : '' }, // 文本部分
                                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageData}` } } // 使用 mimeType
                            ]
                        });
                    } else {
                        // 纯文本消息
                        finalMessagesDeepseek.push({
                            role: 'user',
                            content: typeof currentUserMessageDeepseek.content === 'string' ? currentUserMessageDeepseek.content : JSON.stringify(currentUserMessageDeepseek.content)
                        });
                    }
                }

                const chatanywhereApiHostDeepseek = 'https://openrouter.ai/api/v1'; // 国内使用 // 使用 let 并重命名以避免冲突
                // const chatanywhereApiHostDeepseek = 'https://api.chatanywhere.org'; // 国外使用

                apiRequest = {
                    url: `${chatanywhereApiHostDeepseek}/v1/chat/completions`, // 注意：改变了 API 端点
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${deepseekApiKey}` // 使用 deepseekApiKey
                    },
                    body: JSON.stringify({
                        model: "deepseek/deepseek-chat-v3.1:free", // Deepseek 的模型名称，请根据实际使用的模型进行调整
                        messages: finalMessagesDeepseek, // 使用 messages 数组
                        stream: true // 如果您希望流式传输响应，可以设置此项
                    })
                };
                break;

            case 'qwen':
                const qwenApiKey = env.QWEN_API_KEY;
                if (!qwenApiKey) throw new Error("QWEN_API_KEY 环境变量未设置");

                // 通义千问的多模态格式也要求一个内容数组，但字段名不同。
                const qwenMessages = messages.map(msg => {
                    // 我们需要准确地找到那条附加了图片的用户消息，并修改其结构。
                    // 修正逻辑：如果当前图片存在，并且当前消息是用户消息，且其内容与最后一条用户消息相同。
                    if (imageData && msg.role === 'user' && msg.content === lastUserMessage) {
                        return {
                            role: msg.role,
                            content: [
                                { image: image }, // 千问的字段是 'image'，这里直接使用原生的 `image` 对象，其中应该包含了 base64 字符串
                                { text: msg.content }
                            ]
                        };
                    }
                    // 如果前端原始的 `image` 字段本身就是 base64 字符串，那么 `image` 对象可能需要调整。
                    // 假设 `image` 是前端传来的包含 base64 `url` 的对象
                    if (imageData && msg.role === 'user' ) {
                         return {
                            role: msg.role,
                            content: [
                                { image: `data:${mimeType};base64,${imageData}` }, // 千问的字段如果是直接的base64字符串，则这样传递
                                { text: msg.content }
                            ]
                        };
                    }

                    return msg; // 其他消息保持原样
                });

                apiRequest = {
                    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${qwenApiKey}` },
                    body: JSON.stringify({ model: "qwen-vl-plus", input: { messages: qwenMessages } })
                };
                break;

            default:
                // 如果前端发送了一个未知的模型名称，返回一个错误。
                return new Response(JSON.stringify({ error: '选择了无效的模型' }), { status: 400 });
        }

        // --- 发送请求与返回响应 ---

        // 使用 fetch API 从 Cloudflare 的服务器向目标大模型 API 发送请求。
        const apiResponse = await fetch(apiRequest.url, apiRequest);

        // 如果 API 返回了非 2xx 的状态码，说明请求失败。
        if (!apiResponse.ok) {
            const errorText = await apiResponse.text(); // 读取错误响应体
            throw new Error(`来自 ${model} 的 API 错误: ${errorText}`);
        }

        // 如果是流式传输，直接返回响应流
        if (apiRequest.body && JSON.parse(apiRequest.body).stream) {
            // 对于流式响应，我们直接返回原始的 Response 对象，Cloudflare Workers 会处理流转发
            const { readable, writable } = new TransformStream();
            apiResponse.body.pipeTo(writable);
            return new Response(readable, {
                status: apiResponse.status,
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                }
            });
        }

        const data = await apiResponse.json(); // 解析成功的 JSON 响应

        // --- 响应解析层 ---
        // 从不同模型的成功响应体中，解析出我们需要的回复文本。
        let reply = '';
        switch (model) {
            case 'gemini':
                reply = data.candidates[0].content.parts[0].text;
                break;
            case 'chatgpt':
            case 'deepseek':
                reply = data.choices[0].message.content;
                break;
            case 'qwen':
                reply = data.output.choices[0].message.content[0].text;
                break;
        }

        // 将最终提取出的纯文本回复包装成 JSON 格式，发送回前端。
        return new Response(JSON.stringify({ reply }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (error) {
        // 如果在整个 `try` 块的任何地方发生错误，都会被这里捕获。
        console.error('Cloudflare Function 内部错误:', error); // 在 Cloudflare 的日志中打印详细错误，方便排查。
        // 向前端返回一个统一的 500 错误响应。
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}
