#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Define the plugin using the CAP_PLUGIN Macro, and
// each method the plugin supports using the CAP_PLUGIN_METHOD macro.
CAP_PLUGIN(OpenAIRealtimePlugin, "OpenAIRealtime",
           CAP_PLUGIN_METHOD(start, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(stop, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(onPartialTranscript, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(onFinalTranscript, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(onAudioPlayback, CAPPluginReturnPromise);
)

