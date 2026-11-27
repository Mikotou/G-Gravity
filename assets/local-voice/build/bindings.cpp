// ABI between the Node worker and the pinned MIT-licensed whisper.cpp runtime.
#include <algorithm>
#include <string>
#include "whisper.h"

static std::string transcript;
static void silent(ggml_log_level, const char *, void *) {}

extern "C" whisper_context * voice_init(void * model, size_t length) {
    whisper_log_set(silent, nullptr);
    ggml_log_set(silent, nullptr);
    auto params = whisper_context_default_params();
    params.use_gpu = false;
    return whisper_init_from_buffer_with_params(model, length, params);
}

extern "C" const char * voice_run(whisper_context * context, const float * samples, int count, int language, int padding) {
    if (!context || !samples || count <= 0) return nullptr;
    auto p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    p.language = language == 1 ? "zh" : language == 2 ? "en" : "auto";
    p.n_threads = 1;
    p.no_context = true;
    p.no_timestamps = false;
    p.single_segment = true;
    p.max_tokens = std::max(24, std::min(180, 12 + 12 * count / 16000));
    p.print_special = p.print_progress = p.print_realtime = p.print_timestamps = false;
    p.greedy.best_of = 1;
    p.temperature_inc = 0.0f;
    // One encoder position represents 20 ms. Pad to a multiple of 16 for SIMD kernels.
    const int positions = (count + 319) / 320 + padding;
    p.audio_ctx = std::min(whisper_n_audio_ctx(context), std::max(128, ((positions + 15) / 16) * 16));
    if (whisper_full(context, p, samples, count) != 0) return nullptr;
    transcript.clear();
    for (int i = 0; i < whisper_full_n_segments(context); ++i) {
        transcript += whisper_full_get_segment_text(context, i);
    }
    return transcript.c_str();
}

extern "C" void voice_free(whisper_context * context) {
    whisper_free(context);
    transcript.clear();
}
