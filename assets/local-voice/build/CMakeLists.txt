cmake_minimum_required(VERSION 3.20)
project(gravity_local_voice LANGUAGES C CXX)
if(NOT EMSCRIPTEN OR NOT EXISTS "${WHISPER_SOURCE}/include/whisper.h")
  message(FATAL_ERROR "Use the pinned whisper.cpp source directory and Emscripten toolchain from sources.json")
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(BUILD_SHARED_LIBS OFF)
set(GGML_OPENMP OFF)
set(GGML_NATIVE OFF)
set(GGML_WASM_SINGLE_FILE OFF)
file(REAL_PATH "${WHISPER_SOURCE}" WHISPER_SOURCE)
add_compile_options(-O3 -msimd128
  "-ffile-prefix-map=${WHISPER_SOURCE}=whisper.cpp"
  "-ffile-prefix-map=${CMAKE_CURRENT_BINARY_DIR}=build"
  "-ffile-prefix-map=${CMAKE_CURRENT_SOURCE_DIR}=bindings")
add_subdirectory("${WHISPER_SOURCE}/ggml" ggml EXCLUDE_FROM_ALL)

# Upstream auto detection performs its own encoder pass before applying the caller's context.
# Set the same window for that pass, including the first utterance on a fresh context.
file(READ "${WHISPER_SOURCE}/src/whisper.cpp" whisper_source)
set(detect "const auto lang_id = whisper_lang_auto_detect_with_state")
string(FIND "${whisper_source}" "${detect}" detect_offset)
if(detect_offset EQUAL -1)
  message(FATAL_ERROR "Unexpected Whisper revision")
endif()
string(REPLACE "${detect}" "state->exp_n_audio_ctx = params.audio_ctx;\n        ${detect}" whisper_source "${whisper_source}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/whisper.cpp" "${whisper_source}")
add_executable(voice bindings.cpp "${CMAKE_CURRENT_BINARY_DIR}/whisper.cpp")
target_include_directories(voice PRIVATE "${WHISPER_SOURCE}/include" "${WHISPER_SOURCE}/src")
target_compile_definitions(voice PRIVATE WHISPER_VERSION="1.8.3")
target_link_libraries(voice PRIVATE ggml)
target_link_options(voice PRIVATE -O3 -msimd128 --no-entry
  -sENVIRONMENT=node -sMODULARIZE=1 -sEXPORT_NAME=createWhisper -sFILESYSTEM=0
  -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=5242880
  "-sEXPORTED_FUNCTIONS=_malloc,_free,_voice_init,_voice_run,_voice_free"
  "-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32,UTF8ToString")
set_target_properties(voice PROPERTIES OUTPUT_NAME whisper SUFFIX ".js")
