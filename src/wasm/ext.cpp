#include <emscripten/bind.h>
#include <vector>
#include <memory>
#include <iostream>

#include "mgs_decode.h"

//-------------------------------------------//

static QMmat4 parse_mat4(const emscripten::val& val);

//-------------------------------------------//

EMSCRIPTEN_BINDINGS(libmgs_js)
{
	emscripten::class_<MGSgaussians>("Gaussians")
		.smart_ptr<std::shared_ptr<MGSgaussians>>("Gaussians")

		.constructor(emscripten::optional_override([]()
		{
			auto gaussians = std::make_shared<MGSgaussians>();
			std::memset(gaussians.get(), 0, sizeof(MGSgaussians));

			return gaussians;
		}))

    	.property("length", &MGSgaussians::count)
    	.property("shDegree", &MGSgaussians::shDegree)
    	.property("dynamic", &MGSgaussians::dynamic)
    	.property("colorMin", &MGSgaussians::colorMin)
    	.property("colorMax", &MGSgaussians::colorMax)
    	.property("shMin", &MGSgaussians::shMin)
    	.property("shMax", &MGSgaussians::shMax)

		.property("means", emscripten::optional_override([](const MGSgaussians& self)
		{
			return emscripten::val(emscripten::typed_memory_view(
				self.count * 4, 
				(const float*)self.means
			));
		}))

		.property("covariances", emscripten::optional_override([](const MGSgaussians& self)
		{
			return emscripten::val(emscripten::typed_memory_view(
				self.count * 6, 
				(const float*)self.covariances
			));
		}))

		.property("opacities", emscripten::optional_override([](const MGSgaussians& self)
		{
			return emscripten::val(emscripten::typed_memory_view(
				self.count, 
				(const uint8_t*)self.opacities
			));
		}))

		.property("colors", emscripten::optional_override([](const MGSgaussians& self)
		{
			return emscripten::val(emscripten::typed_memory_view(
				self.count * 3, 
				(const uint16_t*)self.colors
			));
		}))

		.property("shs", emscripten::optional_override([](const MGSgaussians& self)
		{
			uint32_t numShCoeffs = (self.shDegree + 1) * (self.shDegree + 1) - 1;

			return emscripten::val(emscripten::typed_memory_view(
				numShCoeffs * 3, 
				(const uint8_t*)self.shs
			));
		}))

		.property("velocities", emscripten::optional_override([](const MGSgaussians& self)
		{
			return emscripten::val(emscripten::typed_memory_view(
				self.dynamic ? self.count * 4 : 0, 
				(const float*)self.velocities
			));
		}));

	emscripten::value_object<MGSmetadata>("Metadata")
		.field("duration", &MGSmetadata::duration);

	emscripten::function("decode", emscripten::optional_override([](const emscripten::val& arg)
	{
		//decode:
		//---------------
		emscripten::val bufView = emscripten::val::global("Uint8Array").new_(arg);
		std::vector<uint8_t> data = emscripten::convertJSArrayToNumberVector<uint8_t>(bufView);

		auto gaussians = std::shared_ptr<MGSgaussians>(
			new MGSgaussians(),
			[](MGSgaussians* p) {
				mgs_gaussians_free(p);
				delete p;
			}
		);

		MGSmetadata metadata;
		MGSerror error = mgs_decode_from_buffer(data.size(), data.data(), gaussians.get(), &metadata);
		if(error != MGS_SUCCESS)
			throw std::runtime_error("MGS internal error: \"" + std::string(mgs_error_get_description(error)) + "\"");

		//wrap into js object:
		//---------------
		emscripten::val result = emscripten::val::object();
		result.set("gaussians", gaussians);
		result.set("metadata", metadata);

		return result;
	}));

	emscripten::function("combine", emscripten::optional_override([](const std::shared_ptr<MGSgaussians>& g1, const std::shared_ptr<MGSgaussians>& g2)
	{
		std::shared_ptr<MGSgaussians> out = std::make_shared<MGSgaussians>();

		MGSerror error = mgs_gaussians_combine(g1.get(), g2.get(), out.get());
		if(error != MGS_SUCCESS)
			throw std::runtime_error("MGS internal error: \"" + std::string(mgs_error_get_description(error)) + "\"");

		return out;
	}));
}

//-------------------------------------------//

static QMmat4 parse_mat4(const emscripten::val& val)
{
	std::vector<float> arr = emscripten::convertJSArrayToNumberVector<float>(val);
	if(arr.size() != 16)
		throw std::runtime_error("4x4 matrices must have 16 elements!");

	QMmat4 mat;
	std::memcpy(&mat, arr.data(), 16 * sizeof(float));

	return mat;
}