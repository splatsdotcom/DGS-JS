/* mgs_ply.hpp
 *
 * contains a .ply loader
 */

#ifndef MGS_PLY_HPP
#define MGS_PLY_HPP

#include <vector>
#include "mgs_gaussian.hpp"

namespace mgs
{

namespace ply
{

//-------------------------------------------//

std::vector<Gaussian> load(const std::vector<uint8_t>& buf);
std::vector<Gaussian> load(uint64_t size, const uint8_t* buf);

std::vector<GaussianPacked> load_packed(const std::vector<uint8_t>& buf);
std::vector<GaussianPacked> load_packed(uint64_t size, const uint8_t* buf);

}; //namespace ply
}; //namespace mgs

#endif //#ifndef MGS_PLY_HPP
