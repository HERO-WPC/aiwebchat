// /root/桌面/aiwebchat/functions/api/chat.js
// worker.js

// 定义支持的大模型供应商，以便更好地组织和扩展
const PROVIDERS = {
    OLLAMA: 'ollama',
    GEMINI: 'gemini',
};

// =========================================================================
// 主请求处理函数 (使用 ES Module export default)
// =========================================================================
export default {
    async fetch(request, env, ctx) { // 添加 ctx 参数，这是 Pages Functions 的标准签名
        const url = new URL(request.url);

        // 仅处理 POST 请求到 /api/chat 路径
        if (request.method === 'POST' && url.pathname === '/api/chat') {
            return handleChatRequest(request, env);
        }

        // 针对其他路径或方法，返回一个默认的响应
        return new Response('Not Found or Method Not Allowed', { status: 404 });
    }
};

// =========================================================================
// 聊天请求处理函数
// 这是核心逻辑，根据模型选择不同的后端 API
// =========================================================================
async function handleChatRequest(request, env) {
    // 确保请求体为 JSON
    const contentType = request.headers.get('Content-Type');
    if (!contentType || !contentType.includes('application/json')) {
        return new Response(JSON.stringify({ error: 'Unsupported Media Type: Request must be JSON' }), {
            status: 415,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    let requestBody;
    try {
        requestBody = await request.json();
    } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid JSON in request body' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const { model, messages, stream } = requestBody; // 提取请求中的关键信息

    if (!model) {
        return new Response(JSON.stringify({ error: 'Missing "model" in request body' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return new Response(JSON.stringify({ error: 'Missing or empty "messages" array in request body' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    let apiConfig = {}; // 存储 API 请求所需的配置

    // --- 根据模型名称路由到不同的后端 ---
    // 1. **Gemini 模型**
    if (model.startsWith('gemini')) {
        apiConfig = {
            provider: PROVIDERS.GEMINI,
            endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
            apiKey: env.GEMINI_API_KEY, // 使用 Gemini 自己的 API Key
            modelName: model,
            // 构建请求体 (Gemini API 格式)
            body: {
                contents: messages.map(msg => ({
                    role: msg.role === 'user' ? 'user' : 'model', // Gemini API 的角色约定 [1]
                    parts: [{ text: msg.content }]
                })),
                // generationConfig: { /* ... */ },
                // safetySettings: [ /* ... */ ],
            }
        };
        // Gemini 也支持流式传输，需要修改端点 [1]
        if (stream) {
            apiConfig.endpoint = apiConfig.endpoint.replace(':generateContent', ':streamGenerateContent'); // 使用流式端点 [1]
        }
    }
    // 2. **DeepSeek, ChatGPT, 千问 (Qwen) 以及其他 Ollama 模型**
    else if (model.startsWith('deepseek') || model.startsWith('gpt-') || model.startsWith('qwen') || model.startsWith('ollama-')) {
        apiConfig = {
            provider: PROVIDERS.OLLAMA,
            endpoint: `${env.OLLAMA_API_BASE_URL}/v1/chat/completions`, // Ollama 兼容 OpenAI 的端点
            apiKey: null, // Ollama 本地部署通常不需要 API Key
            modelName: model.startsWith('ollama-') ? model.substring('ollama-'.length) : model, // 移除前缀或直接使用模型名称
            // 构建请求体 (Ollama 兼容 OpenAI 格式)
            body: {
                model: model.startsWith('ollama-') ? model.substring('ollama-'.length) : model,
                messages: messages,
                stream: stream !== undefined ? stream : true, // 默认开启流式传输
                // Ollama 还有一些特有的 options 可以添加，如果需要 [4]
            }
        };
        // ⚠️ 如果你需要 Ollama 支持多模态（例如 DeepSeek-VL 或 LLaVA），
        // 并且前端可以发送图片数据，你需要在这里添加图像处理逻辑。
        // 例如：
        /*
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.role === 'user' && requestBody.image) {
            lastMessage.content = [
                { type: 'text', text: lastMessage.content },
                { type: 'image_url', image_url: { url: requestBody.image } }
            ];
        }
        */
    }
    else {
        // 如果没有匹配的模型，返回错误
        return new Response(JSON.stringify({ error: `Unsupported model: ${model}` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // --- 路由器逻辑：根据 apiConfig 发送请求到后端 ---
    try {
        const fetchOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // 只有当 apiKey 存在且不为 null (例如 Ollama 不需要) 时才添加 Authorization 头
                ...(apiConfig.apiKey ? { 'Authorization': `Bearer ${apiConfig.apiKey}` } : {})
            },
            body: JSON.stringify(apiConfig.body),
        };

        // 特殊处理 Gemini API 的 headers，因为其 API Key 是作为 URL 参数传递的
        let finalEndpoint = apiConfig.endpoint;
        if (apiConfig.provider === PROVIDERS.GEMINI) {
            finalEndpoint = `${apiConfig.endpoint}?key=${apiConfig.apiKey}`;
            delete fetchOptions.headers['Authorization']; // 从 headers 中移除 Authorization
        }

        const backendResponse = await fetch(finalEndpoint, fetchOptions);

        // --- 流式响应处理 ---
        if (stream) {
            // 如果是流式响应，直接将后端响应的 ReadableStream 返回给客户端
            return new Response(backendResponse.body, {
                status: backendResponse.status,
                headers: {
                    'Content-Type': backendResponse.headers.get('Content-Type') || 'text/event-stream',
                    'Access-Control-Allow-Origin': '*', // 允许跨域访问
                }
            });
        }

        // --- 非流式响应处理 ---
        let data;
        let contentTypeHeader = backendResponse.headers.get('Content-Type');

        try {
            // 尝试将后端响应解析为 JSON
            data = await backendResponse.json();
        } catch (jsonError) {
            // 如果解析 JSON 失败，说明响应很可能不是 JSON，或者是不完整的 JSON
            const rawErrorText = await backendResponse.text(); // 获取原始文本，以便调试
            console.error(`Backend API returned non-JSON or malformed JSON (Status: ${backendResponse.status}, Content-Type: ${contentTypeHeader || 'None'}):`, rawErrorText);

            // 返回一个包含详细错误信息的 JSON 响应
            return new Response(JSON.stringify({
                error: `Backend API returned unexpected response format. Status: ${backendResponse.status}, Type: ${contentTypeHeader || 'Unknown'}. Details: ${rawErrorText.substring(0, 500)}`,
                statusCode: backendResponse.status,
                originalResponse: rawErrorText // 返回原始响应体以便调试
            }), {
                // 如果后端返回非 200 状态，使用后端状态码；否则默认 500
                status: backendResponse.status !== 200 ? backendResponse.status : 500,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        // 现在 `data` 已经成功解析为 JSON，继续处理业务逻辑

        // 检查后端响应的 HTTP 状态码
        if (!backendResponse.ok) {
            // 如果 HTTP 状态码表示错误（例如 4xx 或 5xx），且响应已成功解析为 JSON
            console.error(`Backend API returned error status (${apiConfig.provider}): Status ${backendResponse.status}, Response: ${JSON.stringify(data)}`);
            return new Response(JSON.stringify({
                error: `Backend API error (${apiConfig.provider}): ${data.message || data.error?.message || JSON.stringify(data)}`,
                statusCode: backendResponse.status,
                originalResponse: data // 包含解析后的错误 JSON 响应
            }), {
                status: backendResponse.status,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        // 检查后端业务逻辑是否返回了错误 (例如，响应体中包含 "error" 字段)
         if (data.error) {
            console.error(`Backend API reported error (${apiConfig.provider}):`, data.error);
            return new Response(JSON.stringify({
                error: `Backend API error (${apiConfig.provider}): ${data.error.message || JSON.stringify(data.error)}`,
                statusCode: backendResponse.status,
                originalResponse: data // 包含解析后的错误 JSON 响应
            }), {
                status: backendResponse.status,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        // 提取回复内容（根据不同供应商的响应结构进行调整）
        let replyContent;
        if (apiConfig.provider === PROVIDERS.GEMINI) {
            // Gemini 返回的结构在 [1] 中提到是 candidates[0].content.parts[0].text
            replyContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
        } else {
            // Ollama 兼容 OpenAI 结构：choices[0].message.content
            replyContent = data.choices?.[0]?.message?.content;
        }


        if (replyContent === undefined) {
             console.warn(`Unexpected backend response structure for ${apiConfig.provider}:`, data);
             return new Response(JSON.stringify({ error: `Unexpected response from ${apiConfig.provider}` }), {
                 status: 500,
                 headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
             });
        }

        // 成功获取回复内容，返回给客户端
        return new Response(JSON.stringify({ reply: replyContent }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });

    } catch (error) {
        // 捕获在 `fetch` 过程中可能发生的网络错误或其他未预期的 Worker 内部错误
        console.error('Worker internal error during backend fetch:', error);
        return new Response(JSON.stringify({ error: `Worker internal error: ${error.message}` }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}
